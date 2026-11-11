// Language servers (LSP): completions, hover, go to definition, references, rename and problems for the editor.
// One server per kind of file and open folder, started the first time such a file opens. TypeScript 7's own
// compiler is the JavaScript and TypeScript server, shipped with Breeze; the others are used when found on the PATH.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';

// The parts of the Language Server Protocol that Breeze reads. A server may leave any optional field out.
export interface Position { line: number; character: number }
export interface Range { start: Position; end: Position }
interface LspMessage { id?: number | string | null; method?: string; params?: any; result?: unknown; error?: { message?: string } }
interface LspDiagnostic { range?: Range; severity?: number; message?: unknown }
interface LspLocation { uri?: string; range: Range; targetUri?: string; targetSelectionRange?: Range }
interface LspTextEdit { range: Range; newText: string }
interface LspCompletionItem {
  label: string; kind?: number; detail?: string; sortText?: string; filterText?: string; insertText?: string; insertTextFormat?: number;
  textEdit?: { newText: string; range?: Range; insert?: Range };
}
type HoverContents = string | { value?: string } | HoverContents[] | null | undefined;
export interface ServerSpec { cmd: string; args: string[]; shell?: boolean; init?: unknown; settings?: Record<string, unknown>; env?: NodeJS.ProcessEnv; cwd?: string }
interface InstallInfo { name: string; cmd?: string | Record<string, string>; url?: string }
interface Doc { kind: string; lang: string; version: number; text: string }
interface Edit { start: number; end: number; text: string }

// File extension → LSP language id and the server that handles it.
const LANGS: Record<string, [string, string]> = {
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
const langOf = (rel: string) => LANGS[path.extname(rel).slice(1).toLowerCase()] ?? null;

// Programs to look for on the PATH, first found wins. `init` is sent as initializationOptions.
const SERVERS: Record<string, { bin: string; args: string[]; init?: unknown }[]> = {
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
const WEB: InstallInfo = { name: 'CSS, HTML and JSON', cmd: 'npm i -g vscode-langservers-extracted', url: 'https://github.com/hrsh7th/vscode-langservers-extracted' };
const INSTALL: Record<string, InstallInfo> = {
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
const installOf = (kind: string, platform: string = process.platform) => {
  const i = INSTALL[kind];
  if (!i) return null;
  return { kind, name: i.name, cmd: (typeof i.cmd === 'object' ? i.cmd[platform] : i.cmd) ?? null, url: i.url ?? null };
};
// One entry per server (CSS, HTML and JSON share one), for the Tools list.
const lspInstalls = (platform: string = process.platform) =>
  Object.keys(INSTALL).filter((k, n, all) => all.findIndex(o => INSTALL[o] === INSTALL[k]) === n).map(k => installOf(k, platform)!);
// The editor's one-line hint when a file's server is missing.
const installHint = (kind: string) => { const i = installOf(kind); return i && (i.cmd ?? `download it from ${i.url}`); };

/* ----- Messages: JSON with a Content-Length header ----- */
function frame(msg: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}
// Splits a byte stream into messages; a message may arrive in pieces or several in one chunk.
class Reader {
  buf: Buffer = Buffer.alloc(0);
  onMessage: (m: LspMessage) => void;
  constructor(onMessage: (m: LspMessage) => void) { this.onMessage = onMessage; }
  push(chunk: Buffer): void {
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
  spec: ServerSpec;
  onNotify: (method: string, params: any) => void;
  nextId = 1;
  pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  caps: { textDocumentSync?: number | { change?: number }; diagnosticProvider?: unknown } = {};
  dead = false;
  child!: ChildProcess;
  ready?: Promise<void>;
  constructor({ cmd, args, shell, cwd, env, init, settings, onNotify }: ServerSpec & { onNotify?: (method: string, params: any) => void }) {
    this.spec = { cmd, args, shell, cwd, env, init, settings };
    this.onNotify = onNotify ?? (() => undefined);
  }
  start(rootDir: string): Promise<void> {
    const { cmd, args, shell, cwd, env, init } = this.spec;
    const child = this.child = spawn(cmd, args, { cwd, env, shell, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const reader = new Reader(m => this.receive(m));
    child.stdout!.on('data', (c: Buffer) => reader.push(c));
    child.stdin!.on('error', () => { /* the server exited */ });
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
    }, 60000).then((r: { capabilities?: Client['caps'] } | null) => { this.caps = r?.capabilities ?? {}; this.notify('initialized', {}); });
    return this.ready;
  }
  send(msg: LspMessage): void { if (!this.dead) this.child.stdin!.write(frame({ jsonrpc: '2.0', ...msg })); }
  notify(method: string, params?: unknown): void { this.send({ method, params }); }
  request<T = any>(method: string, params: unknown, timeout = 15000): Promise<T> {
    if (this.dead) return Promise.reject(new Error('The language server stopped'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeout);
      this.pending.set(id, { resolve: (v: T) => { clearTimeout(timer); resolve(v); }, reject: (e: Error) => { clearTimeout(timer); reject(e); } });
      this.send({ id, method, params });
    });
  }
  receive(m: LspMessage): void {
    if (m.id != null && m.method) { this.answer(m); return; } // the server asks us something
    const p = m.id != null && this.pending.get(m.id as number);
    if (!p) { if (m.method) this.onNotify(m.method, m.params); return; } // a notification (diagnostics, progress)
    this.pending.delete(m.id as number);
    if (m.error) p.reject(new Error(m.error.message || 'Language server error')); else p.resolve(m.result);
  }
  // Settings requests get the server's `settings` by section (or none); registrations and progress bars are
  // accepted and ignored.
  answer(m: LspMessage): void {
    const items: { section?: string }[] = m.params?.items ?? [];
    const settings = this.spec.settings ?? {};
    this.send({ id: m.id, result: m.method === 'workspace/configuration' ? items.map(it => settings[it.section ?? ''] ?? null) : null });
  }
  stop(): void {
    if (this.dead) return;
    this.request('shutdown', null, 2000).catch(() => undefined).then(() => { this.notify('exit'); setTimeout(() => this.child.kill(), 1000); });
  }
}

/* ----- All servers for the open folder ----- */
// `findServer(kind)` returns how to start a server ({ cmd, args, shell?, init? }) or null when none is installed.
class LspManager {
  findServer: (kind: string) => ServerSpec | null | Promise<ServerSpec | null>;
  env: () => NodeJS.ProcessEnv | Promise<NodeJS.ProcessEnv>;
  onDiagnostics: (rel: string, diags: Diag[], lines: number) => void;
  root: string | null = null;
  clients = new Map<string, Promise<Client | null>>(); // kind → its server, once started
  docs = new Map<string, Doc>();                       // rel → the open file
  // `onDiagnostics(rel, diags, lines)` hears each open file's problems; `lines` is the line count they're for.
  constructor({ findServer, env, onDiagnostics }: { findServer: LspManager['findServer']; env: LspManager['env']; onDiagnostics?: LspManager['onDiagnostics'] }) {
    this.findServer = findServer;
    this.env = env;
    this.onDiagnostics = onDiagnostics ?? (() => undefined);
  }
  setRoot(dir: string | null): void {
    if (dir === this.root) return;
    this.stopAll();
    this.root = dir;
  }
  stopAll(): void {
    for (const c of this.clients.values()) c.then(cl => cl?.stop(), () => undefined);
    this.clients.clear();
    this.docs.clear();
  }
  client(kind: string): Promise<Client | null> {
    if (!this.clients.has(kind)) {
      let started!: Promise<Client | null>; // the promise below looks itself up in this.clients
      started = (async () => {
        const spec = await this.findServer(kind);
        // None installed yet: look again when the next file opens, so an install from Settings → Tools is picked up.
        if (!spec) { if (this.clients.get(kind) === started) this.clients.delete(kind); return null; }
        const c = new Client({ ...spec, cwd: this.root!, env: await this.env(), onNotify: (method: string, params: any) => this.notified(method, params) });
        await c.start(this.root!);
        if (this.clients.get(kind) !== started) { c.stop(); return null; } // another folder opened while it started
        return c;
      })();
      started.catch(() => this.clients.delete(kind)); // try again next time a file opens
      this.clients.set(kind, started);
    }
    return this.clients.get(kind)!;
  }
  uri(rel: string): string { return pathToFileURL(path.join(this.root!, rel)).href; }
  // Starts the file's server if needed. Returns what the editor shows: which server, or how to get one.
  async open(rel: string, text: string): Promise<{ available: boolean; error?: string; install?: string | null }> {
    const l = langOf(rel);
    if (!l || !this.root) return { available: false };
    const [lang, kind] = l;
    if (this.docs.has(rel)) { void this.change(rel, text); return { available: true }; }
    // Known before the server is up, so edits made meanwhile follow the open (they wait for the same server).
    const doc: Doc = { kind, lang, version: 1, text };
    this.docs.set(rel, doc);
    let c: Client | null;
    try { c = await this.client(kind); } catch (e) { this.docs.delete(rel); return { available: false, error: (e as Error).message }; }
    if (!c) { this.docs.delete(rel); return { available: false, install: installHint(kind) }; }
    if (this.docs.get(rel) !== doc) return { available: false }; // closed, or another folder opened, meanwhile
    c.notify('textDocument/didOpen', { textDocument: { uri: this.uri(rel), languageId: lang, version: 1, text } });
    void this.pull(rel, c);
    return { available: true };
  }
  // `change` is the whole new text, or one edit { start, end, text } in offsets of the text before it. A server
  // that takes ranges gets just the edit, so a big file isn't sent and re-read in full on every keystroke.
  async change(rel: string, change: string | Edit): Promise<void> {
    const doc = this.docs.get(rel);
    if (!doc) return;
    const before = doc.text;
    const edit = typeof change === 'string' ? null : change;
    doc.text = edit ? before.slice(0, edit.start) + edit.text + before.slice(edit.end) : (change as string);
    const c = await this.client(doc.kind).catch(() => null);
    doc.version++;
    const sync = c?.caps?.textDocumentSync, kind = typeof sync === 'number' ? sync : sync?.change;
    const contentChanges = edit && kind === 2
      ? [{ range: { start: lspPos(before, edit.start), end: lspPos(before, edit.end) }, text: edit.text }]
      : [{ text: doc.text }];
    c?.notify('textDocument/didChange', { textDocument: { uri: this.uri(rel), version: doc.version }, contentChanges });
    if (c) void this.pull(rel, c);
  }
  async close(rel: string): Promise<void> {
    const doc = this.docs.get(rel);
    if (!doc) return;
    this.docs.delete(rel);
    const c = await this.client(doc.kind).catch(() => null);
    c?.notify('textDocument/didClose', { textDocument: { uri: this.uri(rel) } });
  }
  /* ----- Problems: pushed by the server, or asked for after each change when it works that way ----- */
  notified(method: string, params: any): void {
    if (method !== 'textDocument/publishDiagnostics') return;
    const rel = this.relOf(params?.uri ?? '');
    const doc = rel && this.docs.get(rel);
    if (!doc || (params.version != null && params.version !== doc.version)) return; // closed, or for older text
    this.report(rel, doc, params.diagnostics);
  }
  async pull(rel: string, c: Client): Promise<void> {
    if (!c.caps?.diagnosticProvider) return;
    const doc = this.docs.get(rel), version = doc?.version;
    let r: { kind?: string; items?: unknown } | null;
    try { r = await c.request('textDocument/diagnostic', { textDocument: { uri: this.uri(rel) } }, 30000); } catch { return; }
    if (!doc || this.docs.get(rel) !== doc || doc.version !== version) return; // the text changed meanwhile: its own pull follows
    if (r?.kind === 'full') this.report(rel, doc, r.items);
  }
  report(rel: string, doc: Doc, diagnostics: unknown): void {
    this.onDiagnostics(rel, toDiags(diagnostics), doc.text.split('\n').length);
  }
  async ask(rel: string, method: string, extra: Record<string, unknown> = {}, pos?: Position): Promise<any> {
    const doc = this.docs.get(rel);
    if (!doc) return null;
    const c = await this.client(doc.kind);
    if (!c) return null;
    return c.request(method, { textDocument: { uri: this.uri(rel) }, position: pos, ...extra });
  }
  // A file:// URI as a path in the folder (forward slashes), or null for a file outside it (a library's types).
  relOf(uri: string): string | null {
    let abs: string;
    try { abs = fileURLToPath(uri); } catch { return null; }
    const rel = path.relative(this.root!, abs);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : null;
  }
  place(loc: LspLocation) {
    const uri = (loc.targetUri ?? loc.uri)!;
    const range = loc.targetSelectionRange ?? loc.range;
    const rel = this.relOf(uri);
    let file: string | null = rel;
    if (!rel) { try { file = fileURLToPath(uri); } catch { file = uri; } }
    return { path: rel, file, line: range.start.line, col: range.start.character, len: range.end.line === range.start.line ? range.end.character - range.start.character : 0 };
  }
  async completion(rel: string, pos: Position) {
    const r = await this.ask(rel, 'textDocument/completion', { context: { triggerKind: 1 } }, pos);
    const items: LspCompletionItem[] = Array.isArray(r) ? r : r?.items ?? [];
    return items.slice(0, 400).map((it: LspCompletionItem) => ({
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
  async hover(rel: string, pos: Position): Promise<string | null> {
    const r = await this.ask(rel, 'textDocument/hover', {}, pos);
    return r ? hoverText(r.contents) : null;
  }
  async definition(rel: string, pos: Position) {
    const r = await this.ask(rel, 'textDocument/definition', {}, pos);
    return ((Array.isArray(r) ? r : r ? [r] : []) as LspLocation[]).map(l => this.place(l));
  }
  async references(rel: string, pos: Position) {
    const r = await this.ask(rel, 'textDocument/references', { context: { includeDeclaration: true } }, pos);
    // Each with its line's text, read from disk once per file, for the list.
    const lines = new Map<string, string[]>();
    const lineOf = (file: string, n: number) => {
      if (!lines.has(file)) { try { lines.set(file, fs.readFileSync(file, 'utf8').split('\n')); } catch { lines.set(file, []); } }
      return (lines.get(file)![n] ?? '').replace(/\r$/, '');
    };
    return ((r ?? []) as LspLocation[]).map(l => this.place(l)).filter(p => p.path)
      .map(p => ({ ...p, text: lineOf(path.join(this.root!, p.path!), p.line) }));
  }
  // The edits a rename makes, per file in the folder. Edits outside the folder are left out.
  async rename(rel: string, pos: Position, newName: string) {
    const r = await this.ask(rel, 'textDocument/rename', { newName }, pos);
    const out: Record<string, { start: Position; end: Position; text: string }[]> = {};
    const add = (uri: string, edits: LspTextEdit[]) => {
      const p = this.relOf(uri);
      if (p) (out[p] ??= []).push(...edits.map(e => ({ start: e.range.start, end: e.range.end, text: e.newText })));
    };
    for (const [uri, edits] of Object.entries<LspTextEdit[]>(r?.changes ?? {})) add(uri, edits);
    for (const dc of (r?.documentChanges ?? []) as { textDocument?: { uri: string }; edits?: LspTextEdit[] }[]) if (dc.textDocument && dc.edits) add(dc.textDocument.uri, dc.edits);
    return out;
  }
}

// Errors and warnings as the editor draws them: line, column, length on that line, message and severity (1 error,
// 2 warning). Hints and info (unused names, style notes) are left out.
export interface Diag { line: number; col: number; len: number; msg: string; sev: number }
function toDiags(list: unknown): Diag[] {
  return ((Array.isArray(list) ? list : []) as LspDiagnostic[])
    .filter((d): d is LspDiagnostic & { range: Range } => !!d?.range && (d.severity ?? 1) <= 2)
    .map((d): Diag => {
      const { start, end } = d.range;
      const len = end.line === start.line ? Math.max(1, end.character - start.character) : 1;
      return { line: start.line, col: start.character, len, msg: String(d.message ?? '').split('\n')[0], sev: d.severity ?? 1 };
    })
    .sort((a, b) => a.line - b.line || a.col - b.col);
}
// A snippet's text without its tab stops: "log(${1:msg})$0" → "log(msg)".
// An offset as an LSP position: line, and UTF-16 column (what JavaScript strings count).
function lspPos(text: string, off: number): Position {
  let line = 0, start = 0;
  for (let i = text.indexOf('\n'); i !== -1 && i < off; i = text.indexOf('\n', i + 1)) { line++; start = i + 1; }
  return { line, character: off - start };
}
function plainSnippet(text: string, isSnippet: boolean): string {
  if (!isSnippet) return text;
  return text.replace(/\$\{\d+(?::([^}]*))?\}|\$\d+/g, (_m: string, def?: string) => def ?? '').replace(/\\([$}\\])/g, '$1');
}
// Hover contents in their many shapes, as plain text (code fences dropped).
function hoverText(c: HoverContents): string | null {
  if (!c) return null;
  if (Array.isArray(c)) return c.map(hoverText).filter(Boolean).join('\n\n') || null;
  const s = typeof c === 'string' ? c : c.value ?? '';
  return s.replace(/```\w*\n?/g, '').trim() || null;
}

// The first of `names` (with Windows' program extensions) in the PATH's folders.
function findOnPath(names: string[], pathValue: unknown, platform: string = process.platform): string | null {
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

export { LANGS, SERVERS, INSTALL, lspInstalls, langOf, frame, Reader, Client, LspManager, lspPos, plainSnippet, hoverText, findOnPath, toDiags };
