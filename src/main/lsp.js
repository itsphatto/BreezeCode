// Language servers (LSP): completions, hover, go to definition, references and rename for the editor.
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
};
// Where to get each one, for the "no language server" hint.
const INSTALL = {
  python: 'npm i -g pyright', rust: 'rustup component add rust-analyzer', go: 'go install golang.org/x/tools/gopls@latest',
  clangd: 'winget install LLVM.LLVM', csharp: 'dotnet tool install -g csharp-ls',
  css: 'npm i -g vscode-langservers-extracted', html: 'npm i -g vscode-langservers-extracted', json: 'npm i -g vscode-langservers-extracted',
};

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
  constructor({ cmd, args, shell, cwd, env, init, settings }) {
    this.spec = { cmd, args, shell, cwd, env, init, settings };
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
    if (!p) return; // a notification (diagnostics, progress): not used yet
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
  constructor({ findServer, env }) {
    this.findServer = findServer;
    this.env = env;
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
        if (!spec) return null;
        const c = new Client({ ...spec, cwd: this.root, env: await this.env() });
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
    const doc = { kind, lang, version: 1 };
    this.docs.set(rel, doc);
    let c;
    try { c = await this.client(kind); } catch (e) { this.docs.delete(rel); return { available: false, error: e.message }; }
    if (!c) { this.docs.delete(rel); return { available: false, install: INSTALL[kind] ?? null }; }
    if (this.docs.get(rel) !== doc) return { available: false }; // closed, or another folder opened, meanwhile
    c.notify('textDocument/didOpen', { textDocument: { uri: this.uri(rel), languageId: lang, version: 1, text } });
    return { available: true };
  }
  async change(rel, text) {
    const doc = this.docs.get(rel);
    if (!doc) return;
    const c = await this.client(doc.kind).catch(() => null);
    doc.version++;
    c?.notify('textDocument/didChange', { textDocument: { uri: this.uri(rel), version: doc.version }, contentChanges: [{ text }] });
  }
  async close(rel) {
    const doc = this.docs.get(rel);
    if (!doc) return;
    this.docs.delete(rel);
    const c = await this.client(doc.kind).catch(() => null);
    c?.notify('textDocument/didClose', { textDocument: { uri: this.uri(rel) } });
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

// A snippet's text without its tab stops: "log(${1:msg})$0" → "log(msg)".
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

module.exports = { LANGS, SERVERS, langOf, frame, Reader, Client, LspManager, plainSnippet, hoverText, findOnPath };
