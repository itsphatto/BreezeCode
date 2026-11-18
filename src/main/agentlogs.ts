// Chats from Claude Code's and Codex's own logs, so the Agent Board's side bar lists them beside Breeze's own and any
// of them can be carried on in a box. Read only: nothing here writes to either agent's folder.
// Plain functions and no Electron, so test/agentlogs.test.js can cover the parsing.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';

export type LogAgent = 'claude' | 'codex';
export interface ChatLogInfo { agent: LogAgent; session: string; title: string; at: number; cwd: string | null }
export interface ChatLogMsg { role: 'user' | 'agent'; text: string; at: number }
type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const TITLE_MAX = 64, MSG_MAX = 20_000, MSGS_MAX = 200;

const claudeBase = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
const codexBase = () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');

const parse = (line: string): Loose | null => { try { return JSON.parse(line); } catch { return null; } };
const when = (ts: unknown) => (typeof ts === 'string' ? Date.parse(ts) || 0 : 0);
export const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);

// What a person typed, without what the agent's app put around it: reminders, slash-command output, images it saved.
export function cleanPrompt(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/^\[Image: source: [^\]]*\]$/gm, '')
    .trim();
}
// Text an app adds as if the person had typed it: Codex's environment and AGENTS.md blocks, Claude Code's command
// echoes and caveats. A chat that starts with one of Breeze's own one-off questions (a commit message, a chat's title,
// Explain, Improve prompt, the conflict Duel, the planner: renderer git.ts, agents.ts, explaincore.ts, mentions.ts,
// conflictcore.ts) is that question, not a chat.
const NOT_TYPED = /^(<[a-z_-]+[\s>]|# AGENTS\.md|Caveat: |\[Request interrupted)/i;
export const typed = (text: string) => !!text && !NOT_TYPED.test(text);
const ONE_OFF = /^(You are |Write a short title \(2 to 5 words\)|Explain this .{1,40} code from |Rewrite the prompt below so a coding agent)/;
export const oneOff = (firstPrompt: string) => ONE_OFF.test(firstPrompt);

const textParts = (content: unknown, kinds: string[]): string =>
  typeof content === 'string' ? content
    : Array.isArray(content) ? content.filter(c => kinds.includes(c?.type) && typeof c.text === 'string').map(c => c.text).join('\n\n') : '';

/* ----- Claude Code: projects/<folder>/<session>.jsonl, one JSON object per line ----- */
// A person's message: not a tool's result, not one Claude Code added (isMeta), not a sub-agent's, not a summary.
export function claudePrompt(d: Loose): string | null {
  if (d?.type !== 'user' || d.isSidechain || d.isMeta || d.isCompactSummary || d.message?.role !== 'user') return null;
  const c = d.message.content;
  if (Array.isArray(c) && c.some(x => x?.type === 'tool_result')) return null;
  const text = cleanPrompt(textParts(c, ['text']));
  return typed(text) ? text : null;
}
export function claudeReply(d: Loose): string | null {
  if (d?.type !== 'assistant' || d.isSidechain) return null;
  const text = textParts(d.message?.content, ['text']).trim();
  return text || null;
}
// A name for the chat: one it was given (renamed, or named by the app), else its first prompt.
export function claudeTitle(d: Loose | null): string | null {
  const t = d?.type === 'custom-title' ? d.customTitle : d?.type === 'agent-name' ? d.agentName : d?.type === 'summary' ? d.summary : null;
  return typeof t === 'string' && t.trim() ? oneLine(t) : null;
}

/* ----- Codex: sessions/YYYY/MM/DD/rollout-*.jsonl; the first line names the session and its folder ----- */
export function codexPrompt(d: Loose): string | null {
  const p = d?.payload;
  if (d?.type === 'response_item' && p?.type === 'message' && p.role === 'user') {
    const text = cleanPrompt(textParts(p.content, ['input_text']));
    return typed(text) ? text : null;
  }
  return null;
}
export function codexReply(d: Loose): string | null {
  const p = d?.payload;
  if (d?.type === 'response_item' && p?.type === 'message' && p.role === 'assistant') return textParts(p.content, ['output_text']).trim() || null;
  return null;
}
// Older Codex logs only have these events (newer ones have both, so they are used only when there is nothing else).
export function codexEvent(d: Loose): ChatLogMsg | null {
  const p = d?.payload;
  if (d?.type !== 'event_msg' || typeof p?.message !== 'string') return null;
  if (p.type === 'user_message') { const t = cleanPrompt(p.message); return typed(t) ? { role: 'user', text: t, at: when(d.timestamp) } : null; }
  if (p.type === 'agent_message' && p.message.trim()) return { role: 'agent', text: p.message.trim(), at: when(d.timestamp) };
  return null;
}

// One message per turn: the agent's text between two prompts is one reply.
export function chatMessages(lines: string[], agent: LogAgent): ChatLogMsg[] {
  const out: ChatLogMsg[] = [], events: ChatLogMsg[] = [];
  const push = (m: ChatLogMsg) => {
    const last = out[out.length - 1];
    if (m.role === 'agent' && last?.role === 'agent') last.text += `\n\n${m.text}`;
    else out.push(m);
  };
  for (const line of lines) {
    const d = line ? parse(line) : null;
    if (!d) continue;
    const at = when(d.timestamp);
    const user = agent === 'claude' ? claudePrompt(d) : codexPrompt(d);
    if (user) { push({ role: 'user', text: user, at }); continue; }
    const reply = agent === 'claude' ? claudeReply(d) : codexReply(d);
    if (reply) { push({ role: 'agent', text: reply, at }); continue; }
    if (agent === 'codex') { const e = codexEvent(d); if (e) events.push(e); }
  }
  if (!out.length) for (const m of events) push(m);
  for (const m of out) if (m.text.length > MSG_MAX) m.text = `${m.text.slice(0, MSG_MAX)}\n\n…`;
  return out.slice(-MSGS_MAX);
}

/* ----- Listing: each log's folder, first prompt and name, read once per change ----- */
interface Head { session: string | null; cwd: string | null; first: string | null; title: string | null }
// Reads lines until the folder and first prompt are known (a chat's first lines hold both), so big logs aren't read whole.
async function readHead(file: string, agent: LogAgent): Promise<Head> {
  const head: Head = { session: null, cwd: null, first: null, title: null };
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let n = 0;
  try {
    for await (const line of rl) {
      if (++n > 400) break;
      const d = parse(line);
      if (!d) continue;
      if (agent === 'claude') {
        head.cwd ??= typeof d.cwd === 'string' ? d.cwd : null;
        head.session ??= typeof d.sessionId === 'string' ? d.sessionId : null;
        head.title ??= claudeTitle(d);
        head.first ??= claudePrompt(d);
      } else {
        if (d.type === 'session_meta') { head.session = d.payload?.id ?? d.payload?.session_id ?? null; head.cwd = d.payload?.cwd ?? null; }
        head.first ??= codexPrompt(d) ?? (codexEvent(d)?.role === 'user' ? codexEvent(d)!.text : null);
      }
      if (head.cwd && head.first && head.session) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return head;
}
// A name given later in the chat is near its end.
async function readTailTitle(file: string, size: number): Promise<string | null> {
  const len = Math.min(size, 128 * 1024);
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n').slice(len < size ? 1 : 0).reverse();
    for (const l of lines) {
      if (!/"type":"(custom-title|agent-name|summary)"/.test(l)) continue;
      const t = claudeTitle(parse(l));
      if (t) return t;
    }
    return null;
  } finally { await fh.close(); }
}

async function logFiles(dir: string, depth: number): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [] as fs.Dirent[])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) out.push(...await logFiles(p, depth - 1));
    else if (e.isFile() && e.name.endsWith('.jsonl') && depth === 0) out.push(p);
  }
  return out;
}

const infoCache = new Map<string, { key: string; info: ChatLogInfo | null }>();
const fileOf = new Map<string, string>(); // `${agent}:${session}` -> its log, for opening one the list showed
const LIST_MAX = 500;
// Chats in a temporary folder (an agent's scratch space, a test run) are left out.
const inTemp = (cwd: string) => { const t = path.resolve(os.tmpdir()).toLowerCase(); const c = path.resolve(cwd).toLowerCase(); return c === t || c.startsWith(t + path.sep); };

async function infoOf(file: string, agent: LogAgent): Promise<ChatLogInfo | null> {
  const st = await fs.promises.stat(file).catch(() => null);
  if (!st) return null;
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = infoCache.get(file);
  if (hit?.key === key) return hit.info;
  let info: ChatLogInfo | null = null;
  try {
    const h = await readHead(file, agent);
    const session = h.session ?? (agent === 'claude' ? path.basename(file, '.jsonl') : null);
    if (session && h.first && !oneOff(h.first) && !(h.cwd && inTemp(h.cwd))) {
      const title = (agent === 'claude' ? await readTailTitle(file, st.size) : null) ?? h.title ?? oneLine(h.first);
      info = { agent, session, title, at: st.mtimeMs, cwd: h.cwd };
    }
  } catch { /* unreadable: left out */ }
  infoCache.set(file, { key, info });
  return info;
}

// Every chat in both agents' logs, newest first.
export async function listChatLogs(): Promise<ChatLogInfo[]> {
  const files: [string, LogAgent][] = [
    ...(await logFiles(claudeBase(), 1)).map(f => [f, 'claude'] as [string, LogAgent]),
    ...(await logFiles(codexBase(), 3)).map(f => [f, 'codex'] as [string, LogAgent]),
  ];
  const out: ChatLogInfo[] = [];
  for (const [file, agent] of files) {
    const info = await infoOf(file, agent);
    if (!info) continue;
    fileOf.set(`${agent}:${info.session}`, file);
    out.push(info);
  }
  return out.sort((a, b) => b.at - a.at).slice(0, LIST_MAX);
}
// One chat's messages; only a chat the list has shown (the renderer never names a file).
export async function readChatLog(agent: unknown, session: unknown): Promise<ChatLogMsg[] | null> {
  if ((agent !== 'claude' && agent !== 'codex') || typeof session !== 'string') return null;
  const file = fileOf.get(`${agent}:${session}`);
  if (!file) return null;
  const text = await fs.promises.readFile(file, 'utf8').catch(() => null);
  return text == null ? null : chatMessages(text.split('\n'), agent);
}
