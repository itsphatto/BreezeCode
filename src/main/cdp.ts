// Chrome DevTools Protocol client: talks to Node's inspector (`node --inspect-brk`) over a WebSocket.
// Messages are JSON, one per frame: a request { id, method, params } is answered by { id, result } or { id, error },
// and the inspector pushes events { method, params }. Plus the pure helpers that map between the editor's
// breakpoints/frames/values and CDP's.
import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { pathToFileURL, fileURLToPath } from 'node:url';

// The part of a WebSocket the client uses; the global WebSocket fits, and so does a test's fake.
export interface CdpSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (e: any) => void, options?: { once?: boolean }): void;
}

// A breakpoint as the editor sends it.
export interface Breakpoint { condition?: string; hitCondition?: string; logMessage?: string }
// A Runtime.RemoteObject, the fields used here.
export interface RemoteObject { type: string; subtype?: string; value?: unknown; unserializableValue?: string; description?: string; className?: string; objectId?: string }
export interface DebugValue { name: string; value: string; type: string; ref: number }

// Emits each CDP event by its method name ('Debugger.paused', …) with its params, 'warn' (an Error) when handling a
// message threw, and 'close' once, when the socket ends or close() is called.
class CdpClient extends EventEmitter {
  socket: CdpSocket;
  id = 1;
  pending = new Map<number, { resolve: (result: any) => void; reject: (err: Error) => void }>(); // id → its promise
  closed = false;
  // `socket` is an open WebSocket (or anything with send(), close() and addEventListener()).
  constructor(socket: CdpSocket) {
    super();
    this.socket = socket;
    // One bad message or a throwing listener must not escape the socket's handler (an uncaught exception in the main process).
    socket.addEventListener('message', (e: { data: unknown }) => {
      try { this.receive(e.data); } catch (err) { this.emit('warn', err); } // 'warn', not 'error': nothing need listen
    });
    socket.addEventListener('error', () => this.shutdown());
    socket.addEventListener('close', () => this.shutdown());
  }
  // Resolves once the socket is open; rejects when it cannot be reached.
  static connect(wsUrl: string): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try { ws = new WebSocket(wsUrl); } catch (e) { reject(e); return; }
      ws.addEventListener('open', () => resolve(new CdpClient(ws)), { once: true });
      ws.addEventListener('error', () => reject(new Error(`Could not connect to the inspector at ${wsUrl}`)), { once: true });
    });
  }
  // Resolves with the response's result; rejects with its message when the inspector says it failed.
  send<T = any>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error('The inspector connection is closed'));
    const id = this.id++;
    return new Promise((resolve, reject) => {
      const data = JSON.stringify({ id, method, params }); // may throw: nothing registered yet
      this.pending.set(id, { resolve, reject });
      try { this.socket.send(data); } catch (e) { this.pending.delete(id); reject(e); }
    });
  }
  receive(data: unknown): void {
    if (typeof data !== 'string') throw new Error('The inspector sent a non-text message');
    const m = JSON.parse(data);
    if (!m || typeof m !== 'object') throw new Error('The inspector sent something that is not a message');
    if (typeof m.id === 'number') {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message || 'The inspector reported an error')); else p.resolve(m.result ?? {});
      return;
    }
    // CDP methods are 'Domain.event'; anything else could masquerade as the client's own 'error' / 'close'.
    if (typeof m.method === 'string' && m.method.includes('.')) this.emit(m.method, m.params);
  }
  shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error('The inspector connection is closed'));
    this.pending.clear();
    this.emit('close');
  }
  close(): void {
    this.shutdown();
    try { this.socket.close(); } catch { /* already closing */ }
  }
}

// ---- breakpoints ----

function fileUrl(absPath: string): string { return pathToFileURL(absPath).href; }

// The `urlRegex` for Debugger.setBreakpointByUrl. V8 compiles it case-sensitively, and Windows paths are
// case-insensitive (a lower-case drive letter is common), so every letter becomes a [xX] class. Matches the URL
// Node reports for the script (file:///C:/… with %20 for spaces), the same with a literal space, and the raw path.
function urlRegexFor(absPath: string): string {
  const href = fileUrl(absPath);
  let decoded = href;
  try { decoded = 'file:///' + decodeURIComponent(href.slice('file:///'.length)); } catch { /* keep the encoded form */ }
  const fold = (s: string) => Array.from(s, c => {
    if (c.toLowerCase() !== c.toUpperCase()) return `[${c.toLowerCase()}${c.toUpperCase()}]`;
    return /[.*+?^${}()|[\]\\/-]/.test(c) ? `\\${c}` : c;
  }).join('');
  return `^(?:${[...new Set([href, decoded, absPath])].map(fold).join('|')})$`;
}

const HIT_RE = /^\s*(>=|<=|==|=|>|<|%)?\s*(\d+)\s*$/;

// A condition as written: trimmed, one trailing ';' dropped (it would not parse inside parentheses).
const conditionOf = (bp: Breakpoint) => (bp.condition || '').trim().replace(/;$/, '').trim();

// A logMessage as text and {expr} parts. Empty or blank braces are literal text, not an expression.
function logParts(msg: string): { expr?: string; text?: string }[] {
  return msg.split(/(\{[^{}]*\})/).filter(Boolean).map(seg =>
    /^\{[^{}]*\}$/.test(seg) && seg.slice(1, -1).trim() ? { expr: seg.slice(1, -1) } : { text: seg });
}

// The breakpoint's `condition` for CDP, which pauses when the expression is truthy. Hit counts and logpoints are
// folded into it: a counter per breakpoint id lives on globalThis in the debuggee, and a logpoint logs then evaluates false.
// V8 treats a condition that fails to parse, or throws when run, as false: the breakpoint silently never pauses (see checkBp).
// Every user expression is closed on its own line so a trailing // comment cannot swallow the closing paren.
function cdpCondition(bp: Breakpoint, id: number): string {
  const parts: string[] = [];
  const cond = conditionOf(bp);
  if (cond) parts.push(`(${cond}\n)`);
  const hit = HIT_RE.exec(bp.hitCondition || '');
  if (hit) {
    const n = Number(hit[2]);
    const op = hit[1] || '>=';
    const key = `globalThis.__bzHit[${Number(id)}]`;
    const test = op === '%' ? `${key} % ${n} === 0` : `${key} ${op === '=' ? '==' : op} ${n}`;
    parts.push(`((globalThis.__bzHit ??= {})[${Number(id)}] = (${key} ?? 0) + 1, ${test})`);
  }
  if (bp.logMessage) {
    // Text is literal in the template; each {expr} runs on its own, so one that throws prints a marker instead of killing the log.
    const tpl = logParts(bp.logMessage).map(p => p.text !== undefined
      ? p.text.replace(/[\\`$]/g, '\\$&')
      : `\${(() => { try { return (${p.expr}\n); } catch (e) { return '<error: ' + String(e && e.message || e) + '>'; } })()}`).join('');
    parts.push(`(console.log(\`${tpl}\`), false)`);
  }
  return parts.join(' && ');
}

// Why an expression would not parse (a short message), or null when it does. Parses only: nothing runs.
function checkExpr(expr: string): string | null {
  try { new vm.Script('(' + expr + '\n)'); return null; } catch (e) { return String((e as Error | undefined)?.message || e); }
}

// The first problem with a breakpoint's condition, log message or hit count, or null. V8 drops a bad condition
// without a word, so the UI marks the breakpoint invalid instead. (A valid condition that throws when run just doesn't pause.)
function checkBp(bp: Breakpoint): string | null {
  const cond = conditionOf(bp);
  if (cond) { const e = checkExpr(cond); if (e) return `Condition: ${e}`; }
  if (bp.logMessage) {
    for (const p of logParts(bp.logMessage)) {
      if (p.expr === undefined) continue;
      const e = checkExpr(p.expr);
      if (e) return `Log message {${p.expr.trim()}}: ${e}`;
    }
  }
  const hit = (bp.hitCondition || '').trim();
  if (hit && !HIT_RE.test(hit)) return `Hit count "${hit}": use a number, or an operator (>=, >, ==, %) and a number`;
  return null;
}

// ---- values and frames ----

const firstLine = (s: unknown) => String(s).split('\n')[0];

// A Runtime.RemoteObject as a DebugValue; `refFor(objectId)` hands out the ref an expandable value is fetched by.
function valueOf(name: string, ro: RemoteObject | null | undefined, refFor: (objectId: string) => number): DebugValue {
  if (!ro) return { name, value: 'undefined', type: 'undefined', ref: 0 };
  const type = ro.subtype || ro.type;
  switch (ro.type) {
    case 'string': return { name, value: JSON.stringify(ro.value), type, ref: 0 };
    case 'number': case 'bigint':
      return { name, value: ro.unserializableValue ?? String(ro.value ?? ro.description), type, ref: 0 };
    case 'boolean': return { name, value: String(ro.value), type, ref: 0 };
    case 'undefined': return { name, value: 'undefined', type, ref: 0 };
    case 'symbol': return { name, value: ro.description ?? 'Symbol()', type, ref: 0 };
  }
  if (ro.subtype === 'null') return { name, value: 'null', type, ref: 0 };
  const text = ro.description ?? ro.className ?? ro.type;
  return {
    name,
    value: ro.type === 'function' || ro.subtype === 'error' ? firstLine(text) : text,
    type,
    ref: ro.objectId ? refFor(ro.objectId) : 0,
  };
}

// Debugger.paused's callFrames as DebugFrames: 1-based line and column; `file` is project-relative with forward
// slashes, or null for a script outside `root`, a node: internal, or one with no URL. `id` is the frame's index.
export interface CallFrame { functionName?: string; url?: string; location?: { scriptId?: string; lineNumber?: number; columnNumber?: number } }
function framesOf(callFrames: CallFrame[], scripts: Map<string, string>, root: string) {
  return callFrames.map((cf, i) => {
    const loc = cf.location || {};
    return {
      id: i,
      name: cf.functionName || '(anonymous)',
      file: relativeFile((loc.scriptId !== undefined ? scripts.get(loc.scriptId) : undefined) ?? cf.url, root),
      line: (loc.lineNumber ?? 0) + 1,
      col: (loc.columnNumber ?? 0) + 1,
    };
  });
}

function relativeFile(url: unknown, root: string): string | null {
  if (typeof url !== 'string' || !url.startsWith('file:')) return null;
  let abs: string;
  try { abs = fileURLToPath(url); } catch { return null; }
  const rel = path.relative(root, abs); // case-insensitive on Windows
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

export { CdpClient, fileUrl, urlRegexFor, cdpCondition, checkExpr, checkBp, valueOf, framesOf };
