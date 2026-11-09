// Language servers (LSP): completions, hover, go to definition, references, rename and problems for the editor.
// One server per kind of file and open folder, started the first time such a file opens. TypeScript 7's own
// compiler is the JavaScript and TypeScript server, shipped with Breeze; the others are used when found on the PATH.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL, fileURLToPath } = require('node:url');

// File extension → LSP language id and the server that handles it.
const LANGS = {
  ts: ['typescript', 'ts'], mts: ['typescript', 'ts'], cts: ['typescript', 'ts'], tsx: ['typescriptreact', 'ts'],
  js: ['javascript', 'ts'], mjs: ['javascript', 'ts'], cjs: ['javascript', 'ts'], jsx: ['javascriptreact', 'ts'],
  py: ['python', 'python'],
  rs: ['rust', 'rust'],
  go: ['go', 'go'],
  c: ['c', 'clangd'], h: ['c', 'clangd'], cpp: ['cpp', 'clangd'], cc: ['cpp', 'clangd'], cxx: ['cpp', 'clangd'], hpp: ['cpp', 'clangd'],
  cs: ['csharp', 'csharp'],
  css: ['css', 'css'], scss: ['scss', 'css'], less: ['less', 'css'],
  html: ['html', 'html'], htm: ['html', 'html'],
  json: ['json', 'json'], jsonc: ['jsonc', 'json'],
  java: ['java', 'java'], php: ['php', 'php'], phtml: ['php', 'php'],
  rb: ['ruby', 'ruby'], rake: ['ruby', 'ruby'], gemspec: ['ruby', 'ruby'], kt: ['kotlin', 'kotlin'], kts: ['kotlin', 'kotlin'],
  swift: ['swift', 'swift'], dart: ['dart', 'dart'], zig: ['zig', 'zig'], scala: ['scala', 'scala'], sc: ['scala', 'scala'],
  ex: ['elixir', 'elixir'], exs: ['elixir', 'elixir'], hs: ['haskell', 'haskell'], r: ['r', 'r'], pl: ['perl', 'perl'], pm: ['perl', 'perl'],
  groovy: ['groovy', 'groovy'], gradle: ['groovy', 'groovy'],
};
const langOf = rel => LANGS[path.extname(rel).slice(1).toLowerCase()] ?? null;

// Programs to look for on the PATH, first found wins. `init` is sent as initializationOptions.
const SERVERS = {
  python: [{ bin: 'pyright-langserver', args: ['--stdio'] }, { bin: 'basedpyright-langserver', args: ['--stdio'] }, { bin: 'pylsp', args: [] }],
  // Build scripts and proc macros would run the project's own code just by opening it, so they stay off.
  rust: [{ bin: 'rust-analyzer', args: [], init: { cargo: { buildScripts: { enable: false } }, procMacro: { enable: false }, checkOnSave: false } }],
  go: [{ bin: 'gopls', args: [] }],
  clangd: [{ bin: 'clangd', args: [] }],
  csharp: [{ bin: 'csharp-ls', args: [] }],
  css: [{ bin: 'vscode-css-language-server', args: ['--stdio'] }],
  html: [{ bin: 'vscode-html-language-server', args: ['--stdio'] }],
  json: [{ bin: 'vscode-json-language-server', args: ['--stdio'] }],
  // Windows installs several of these as .cmd/.bat shims (npm, gem, the elixir-ls zip), which findServer runs through
  // cmd.exe; their arguments are all plain words. R is R.exe, so its -e expression never goes through a shell.
  java: [{ bin: 'jdtls', args: [] }],
  php: [{ bin: 'intelephense', args: ['--stdio'] }],
  ruby: [{ bin: 'solargraph', args: ['stdio'] }],
  kotlin: [{ bin: 'kotlin-language-server', args: [] }],
  swift: [{ bin: 'sourcekit-lsp', args: [] }],
  dart: [{ bin: 'dart', args: ['language-server'] }],
  zig: [{ bin: 'zls', args: [] }],
  scala: [{ bin: 'metals', args: [] }],
  elixir: [{ bin: 'elixir-ls', args: [] }, { bin: 'language_server', args: [] }],
  haskell: [{ bin: 'haskell-language-server-wrapper', args: ['--lsp'] }],
  r: [{ bin: 'R', args: ['--slave', '-e', 'languageserver::run()'] }],
  perl: [{ bin: 'perlnavigator', args: [] }],
  groovy: [{ bin: 'groovy-language-server', args: [] }],
};
// Where to get each one, for Settings → Tools and the "no language server" hint. `cmd` is what the Install button
// runs in a terminal (one string, or one per platform); `url` is the download page. Nothing installs on its own.
const WEB = { name: 'CSS, HTML and JSON', cmd: 'npm i -g vscode-langservers-extracted', url: 'https://github.com/hrsh7th/vscode-langservers-extracted' };
const INSTALL = {
  python: { name: 'Python (Pyright)', cmd: 'npm i -g pyright', url: 'https://github.com/microsoft/pyright' },
  rust: { name: 'Rust (rust-analyzer)', cmd: 'rustup component add rust-analyzer', url: 'https://rust-analyzer.github.io' },
  go: { name: 'Go (gopls)', cmd: 'go install golang.org/x/tools/gopls@latest', url: 'https://go.dev/gopls' },
  clangd: { name: 'C/C++ (clangd)', cmd: { win32: 'winget install LLVM.LLVM', darwin: 'brew install llvm' }, url: 'https://clangd.llvm.org/installation' },
  csharp: { name: 'C# (csharp-ls)', cmd: 'dotnet tool install -g csharp-ls', url: 'https://github.com/razzmatazz/csharp-language-server' },
  css: WEB, html: WEB, json: WEB,
  java: { name: 'Java (jdtls)', cmd: { darwin: 'brew install jdtls' }, url: 'https://download.eclipse.org/jdtls/milestones/' },
  php: { name: 'PHP (Intelephense)', cmd: 'npm i -g intelephense', url: 'https://intelephense.com' },
  ruby: { name: 'Ruby (Solargraph)', cmd: 'gem install solargraph', url: 'https://solargraph.org' },
  kotlin: { name: 'Kotlin', cmd: { darwin: 'brew install kotlin-language-server' }, url: 'https://github.com/fwcd/kotlin-language-server/releases' },
  swift: { name: 'Swift (sourcekit-lsp, comes with Swift)', url: 'https://www.swift.org/install/' },
  dart: { name: 'Dart (comes with the Dart SDK)', url: 'https://dart.dev/get-dart' },
  zig: { name: 'Zig (zls)', cmd: { darwin: 'brew install zls' }, url: 'https://github.com/zigtools/zls/releases' },
  scala: { name: 'Scala (Metals)', cmd: 'cs install metals', url: 'https://scalameta.org/metals/' },
  elixir: { name: 'Elixir (ElixirLS)', cmd: { darwin: 'brew install elixir-ls' }, url: 'https://github.com/elixir-lsp/elixir-ls/releases' },
  haskell: { name: 'Haskell (HLS)', cmd: 'ghcup install hls', url: 'https://www.haskell.org/ghcup/' },
  r: { name: 'R (languageserver)', cmd: `R -e "install.packages('languageserver', repos='https://cloud.r-project.org')"`, url: 'https://github.com/REditorSupport/languageserver' },
  perl: { name: 'Perl (Perl Navigator)', cmd: 'npm i -g perlnavigator-server', url: 'https://github.com/bscan/PerlNavigator' },
  groovy: { name: 'Groovy', url: 'https://github.com/GroovyLanguageServer/groovy-language-server' },
};
const installOf = (kind, platform = process.platform) => {
  const i = INSTALL[kind];
  if (!i) return null;
  return { kind, name: i.name, cmd: (typeof i.cmd === 'object' ? i.cmd[platform] : i.cmd) ?? null, url: i.url ?? null };
};
// One entry per server (CSS, HTML and JSON share one), for the Tools list.
const lspInstalls = (platform = process.platform) =>
  Object.keys(INSTALL).filter((k, n, all) => all.findIndex(o => INSTALL[o] === INSTALL[k]) === n).map(k => installOf(k, platform));
// The editor's one-line hint when a file's server is missing.
const installHint = (kind) => { const i = installOf(kind); return i && (i.cmd ?? `download it from ${i.url}`); };

/* ----- Messages: JSON with a Content-Length header ----- */
function frame(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}
// Splits a byte stream into messages; a message may arrive in pieces or several in one chunk.
class Reader {
  constructor(onMessage) { this.buf = Buffer.alloc(0); this.onMessage = onMessage; }
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const end = this.buf.indexOf('\r\n\r\n');
      if (end === -1) return;
      const len = Number(/content-length:\s*(\d+)/i.exec(this.buf.subarray(0, end).toString('ascii'))?.[1]);
      if (!Number.isFinite(len)) { this.buf = this.buf.subarray(end + 4); continue; } // garbage before a header
      if (this.buf.length < end + 4 + len) return;
      const body = this.buf.subarray(end + 4, end + 4 + len).toString('utf8');
      this.buf = this.buf.subarray(end + 4 + len);
      try { this.onMessage(JSON.parse(body)); } catch { /* not JSON: skip it */ }
    }
  }
}

/* ----- One running server ----- */
class Client {
  constructor({ cmd, args, shell, cwd, env, init, settings, onNotify }) {
    this.spec = { cmd, args, shell, cwd, env, init, settings };
    this.onNotify = onNotify ?? (() => undefined);
    this.nextId = 1;
    this.pending = new Map();
    this.caps = {};
    this.dead = false;
  }
  start(rootDir) {
    const { cmd, args, shell, cwd, env, init } = this.spec;
    const child = this.child = spawn(cmd, args, { cwd, env, shell, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const reader = new Reader(m => this.receive(m));
    child.stdout.on('data', c => reader.push(c));
    child.stdin.on('error', () => { /* the server exited */ });
    const gone = () => {
      this.dead = true;
      for (const p of this.pending.values()) p.reject(new Error('The language server stopped'));
      this.pending.clear();
    };
    child.on('error', gone);
    child.on('exit', gone);
    const uri = pathToFileURL(rootDir).href;
    this.ready = this.request('initialize', {
      processId: process.pid,
      rootUri: uri,
      workspaceFolders: [{ uri, name: path.basename(rootDir) }],
      initializationOptions: init,
      capabilities: {
        textDocument: {
          synchronization: { didSave: false, dynamicRegistration: false },
          completion: { completionItem: { snippetSupport: true, documentationFormat: ['plaintext', 'markdown'] }, contextSupport: true },
          hover: { contentFormat: ['plaintext', 'markdown'] },
          definition: { linkSupport: true },
          references: {},
          rename: { prepareSupport: false },
          publishDiagnostics: { versionSupport: true },
          diagnostic: { dynamicRegistration: false },
        },
        workspace: { workspaceFolders: true, configuration: true, workspaceEdit: { documentChanges: true } },
      },
    }, 60000).then(r => { this.caps = r?.capabilities ?? {}; this.notify('initialized', {}); });
    return this.ready;
  }
  send(msg) { if (!this.dead) this.child.stdin.write(frame({ jsonrpc: '2.0', ...msg })); }
  notify(method, params) { this.send({ method, params }); }
  request(method, params, timeout = 15000) {
    if (this.dead) return Promise.reject(new Error('The language server stopped'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeout);
      this.pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
      this.send({ id, method, params });
    });
  }
  receive(m) {
    if (m.id != null && m.method) { this.answer(m); return; } // the server asks us something
    const p = m.id != null && this.pending.get(m.id);
    if (!p) { if (m.method) this.onNotify(m.method, m.params); return; } // a notification (diagnostics, progress)
    this.pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message || 'Language server error')); else p.resolve(m.result);
  }
  // Settings requests get the server's `settings` by section (or none); registrations and progress bars are
  // accepted and ignored.
  answer(m) {
    const items = m.params?.items ?? [];
    const settings = this.spec.settings ?? {};
    this.send({ id: m.id, result: m.method === 'workspace/configuration' ? items.map(it => settings[it.section] ?? null) : null });
  }
  stop() {
    if (this.dead) return;
    this.request('shutdown', null, 2000).catch(() => undefined).then(() => { this.notify('exit'); setTimeout(() => this.child.kill(), 1000); });
  }
}

/* ----- All servers for the open folder ----- */
// `findServer(kind)` returns how to start a server ({ cmd, args, shell?, init? }) or null when none is installed.
class LspManager {
  // `onDiagnostics(rel, diags, lines)` hears each open file's problems; `lines` is the line count they're for.
  constructor({ findServer, env, onDiagnostics }) {
    this.findServer = findServer;
    this.env = env;
    this.onDiagnostics = onDiagnostics ?? (() => undefined);
    this.root = null;
    this.clients = new Map(); // kind → Promise<Client | null>
    this.docs = new Map();    // rel → { kind, lang, version }
  }
  setRoot(dir) {
    if (dir === this.root) return;
    this.stopAll();
    this.root = dir;
  }
  stopAll() {
    for (const c of this.clients.values()) c.then(cl => cl?.stop(), () => undefined);
    this.clients.clear();
    this.docs.clear();
  }
  client(kind) {
    if (!this.clients.has(kind)) {
      const started = (async () => {
        const spec = await this.findServer(kind);
        // None installed yet: look again when the next file opens, so an install from Settings → Tools is picked up.
        if (!spec) { if (this.clients.get(kind) === started) this.clients.delete(kind); return null; }
        const c = new Client({ ...spec, cwd: this.root, env: await this.env(), onNotify: (method, params) => this.notified(method, params) });
        await c.start(this.root);
        if (this.clients.get(kind) !== started) { c.stop(); return null; } // another folder opened while it started
        return c;
      })();
      started.catch(() => this.clients.delete(kind)); // try again next time a file opens
      this.clients.set(kind, started);
    }
    return this.clients.get(kind);
  }
  uri(rel) { return pathToFileURL(path.join(this.root, rel)).href; }
  // Starts the file's server if needed. Returns what the editor shows: which server, or how to get one.
  async open(rel, text) {
    const l = langOf(rel);
    if (!l || !this.root) return { available: false };
    const [lang, kind] = l;
    if (this.docs.has(rel)) { void this.change(rel, text); return { available: true }; }
    // Known before the server is up, so edits made meanwhile follow the open (they wait for the same server).
    const doc = { kind, lang, version: 1, text };
    this.docs.set(rel, doc);
    let c;
    try { c = await this.client(kind); } catch (e) { this.docs.delete(rel); return { available: false, error: e.message }; }
    if (!c) { this.docs.delete(rel); return { available: false, install: installHint(kind) }; }
    if (this.docs.get(rel) !== doc) return { available: false }; // closed, or another folder opened, meanwhile
    c.notify('textDocument/didOpen', { textDocument: { uri: this.uri(rel), languageId: lang, version: 1, text } });
    void this.pull(rel, c);
    return { available: true };
  }
  // `change` is the whole new text, or one edit { start, end, text } in offsets of the text before it. A server
  // that takes ranges gets just the edit, so a big file isn't sent and re-read in full on every keystroke.
  async change(rel, change) {
    const doc = this.docs.get(rel);
    if (!doc) return;
    const before = doc.text;
    const edit = typeof change === 'string' ? null : change;
    doc.text = edit ? before.slice(0, edit.start) + edit.text + before.slice(edit.end) : change;
    const c = await this.client(doc.kind).catch(() => null);
    doc.version++;
    const sync = c?.caps?.textDocumentSync, kind = typeof sync === 'number' ? sync : sync?.change;
    const contentChanges = edit && kind === 2
      ? [{ range: { start: lspPos(before, edit.start), end: lspPos(before, edit.end) }, text: edit.text }]
      : [{ text: doc.text }];
    c?.notify('textDocument/didChange', { textDocument: { uri: this.uri(rel), version: doc.version }, contentChanges });
    if (c) void this.pull(rel, c);
  }
  async close(rel) {
    const doc = this.docs.get(rel);
    if (!doc) return;
    this.docs.delete(rel);
    const c = await this.client(doc.kind).catch(() => null);
    c?.notify('textDocument/didClose', { textDocument: { uri: this.uri(rel) } });
  }
  /* ----- Problems: pushed by the server, or asked for after each change when it works that way ----- */
  notified(method, params) {
    if (method !== 'textDocument/publishDiagnostics') return;
    const rel = this.relOf(params?.uri ?? '');
    const doc = rel && this.docs.get(rel);
    if (!doc || (params.version != null && params.version !== doc.version)) return; // closed, or for older text
    this.report(rel, doc, params.diagnostics);
  }
  async pull(rel, c) {
    if (!c.caps?.diagnosticProvider) return;
    const doc = this.docs.get(rel), version = doc?.version;
    let r;
    try { r = await c.request('textDocument/diagnostic', { textDocument: { uri: this.uri(rel) } }, 30000); } catch { return; }
    if (this.docs.get(rel) !== doc || doc.version !== version) return; // the text changed meanwhile: its own pull follows
    if (r?.kind === 'full') this.report(rel, doc, r.items);
  }
  report(rel, doc, diagnostics) {
    this.onDiagnostics(rel, toDiags(diagnostics), doc.text.split('\n').length);
  }
  async ask(rel, method, extra = {}, pos) {
    const doc = this.docs.get(rel);
    if (!doc) return null;
    const c = await this.client(doc.kind);
    if (!c) return null;
    return c.request(method, { textDocument: { uri: this.uri(rel) }, position: pos, ...extra });
  }
  // A file:// URI as a path in the folder (forward slashes), or null for a file outside it (a library's types).
  relOf(uri) {
    let abs;
    try { abs = fileURLToPath(uri); } catch { return null; }
    const rel = path.relative(this.root, abs);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : null;
  }
  place(loc) {
    const uri = loc.targetUri ?? loc.uri;
    const range = loc.targetSelectionRange ?? loc.range;
    const rel = this.relOf(uri);
    let file = rel;
    if (!rel) { try { file = fileURLToPath(uri); } catch { file = uri; } }
    return { path: rel, file, line: range.start.line, col: range.start.character, len: range.end.line === range.start.line ? range.end.character - range.start.character : 0 };
  }
  async completion(rel, pos) {
    const r = await this.ask(rel, 'textDocument/completion', { context: { triggerKind: 1 } }, pos);
    const items = Array.isArray(r) ? r : r?.items ?? [];
    return items.slice(0, 400).map(it => ({
      label: it.label,
      kind: it.kind ?? 0,
      detail: it.detail ?? '',
      sort: it.sortText ?? it.label,
      filter: it.filterText ?? it.label,
      insert: plainSnippet(it.textEdit?.newText ?? it.insertText ?? it.label, it.insertTextFormat === 2),
      // Where the inserted text starts, when the server says (it may replace more than the word, like a ".").
      from: (it.textEdit?.range ?? it.textEdit?.insert)?.start ?? null,
    }));
  }
  async hover(rel, pos) {
    const r = await this.ask(rel, 'textDocument/hover', {}, pos);
    return r ? hoverText(r.contents) : null;
  }
  async definition(rel, pos) {
    const r = await this.ask(rel, 'textDocument/definition', {}, pos);
    return (Array.isArray(r) ? r : r ? [r] : []).map(l => this.place(l));
  }
  async references(rel, pos) {
    const r = await this.ask(rel, 'textDocument/references', { context: { includeDeclaration: true } }, pos);
    // Each with its line's text, read from disk once per file, for the list.
    const lines = new Map();
    const lineOf = (file, n) => {
      if (!lines.has(file)) { try { lines.set(file, fs.readFileSync(file, 'utf8').split('\n')); } catch { lines.set(file, []); } }
      return (lines.get(file)[n] ?? '').replace(/\r$/, '');
    };
    return (r ?? []).map(l => this.place(l)).filter(p => p.path)
      .map(p => ({ ...p, text: lineOf(path.join(this.root, p.path), p.line) }));
  }
  // The edits a rename makes, per file in the folder. Edits outside the folder are left out.
  async rename(rel, pos, newName) {
    const r = await this.ask(rel, 'textDocument/rename', { newName }, pos);
    const out = {};
    const add = (uri, edits) => {
      const p = this.relOf(uri);
      if (p) (out[p] ??= []).push(...edits.map(e => ({ start: e.range.start, end: e.range.end, text: e.newText })));
    };
    for (const [uri, edits] of Object.entries(r?.changes ?? {})) add(uri, edits);
    for (const dc of r?.documentChanges ?? []) if (dc.textDocument && dc.edits) add(dc.textDocument.uri, dc.edits);
    return out;
  }
}

// Errors and warnings as the editor draws them: line, column, length on that line, message and severity (1 error,
// 2 warning). Hints and info (unused names, style notes) are left out.
function toDiags(list) {
  return (Array.isArray(list) ? list : [])
    .filter(d => d?.range && (d.severity ?? 1) <= 2)
    .map(d => {
      const { start, end } = d.range;
      const len = end.line === start.line ? Math.max(1, end.character - start.character) : 1;
      return { line: start.line, col: start.character, len, msg: String(d.message ?? '').split('\n')[0], sev: d.severity ?? 1 };
    })
    .sort((a, b) => a.line - b.line || a.col - b.col);
}
// A snippet's text without its tab stops: "log(${1:msg})$0" → "log(msg)".
// An offset as an LSP position: line, and UTF-16 column (what JavaScript strings count).
function lspPos(text, off) {
  let line = 0, start = 0;
  for (let i = text.indexOf('\n'); i !== -1 && i < off; i = text.indexOf('\n', i + 1)) { line++; start = i + 1; }
  return { line, character: off - start };
}
function plainSnippet(text, isSnippet) {
  if (!isSnippet) return text;
  return text.replace(/\$\{\d+(?::([^}]*))?\}|\$\d+/g, (_m, def) => def ?? '').replace(/\\([$}\\])/g, '$1');
}
// Hover contents in their many shapes, as plain text (code fences dropped).
function hoverText(c) {
  if (!c) return null;
  if (Array.isArray(c)) return c.map(hoverText).filter(Boolean).join('\n\n') || null;
  const s = typeof c === 'string' ? c : c.value ?? '';
  return s.replace(/```\w*\n?/g, '').trim() || null;
}

// The first of `names` (with Windows' program extensions) in the PATH's folders.
function findOnPath(names, pathValue, platform = process.platform) {
  const dirs = String(pathValue || '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const name of names) {
    for (const dir of dirs) {
      for (const ext of exts) {
        const p = path.join(dir, name + ext);
        try { if (fs.statSync(p).isFile()) return p; } catch { /* not here */ }
      }
    }
  }
  return null;
}

module.exports = { LANGS, SERVERS, INSTALL, lspInstalls, langOf, frame, Reader, Client, LspManager, lspPos, plainSnippet, hoverText, findOnPath, toDiags };
