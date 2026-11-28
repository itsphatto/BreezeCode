// Second brain: each project folder's memory, made from what agents' compaction summaries said.
// Plain functions and a class with no Electron, so test/secondbrain.test.js can cover them.
// A summary is split into small typed memories (fact, decision, task) and the files they name; memories that
// name the same file or share uncommon words are linked. Kept on this computer only, in second-brain.json.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { memoryRefusal, scopeOf, MAX_TEXT } from './agentmemory';

export type Kind = 'fact' | 'decision' | 'task' | 'file';
// `chats`: the chats it came from; it goes when the last of them is deleted. None: it came from elsewhere too and stays.
export interface BrainNode { id: string; kind: Kind; text: string; at: number; agent: string; hits: number; chats?: string[] }
export interface BrainLink { a: string; b: string; w: number }
export interface Graph { nodes: BrainNode[]; links: BrainLink[] }
export const MAX_NODES = 1500;
export const MAX_LINKS = Infinity; // no limit on links per memory (slice(0, -1) would drop the last one instead)
export const MIN_JACCARD = 0.25;
const MAX_SEEN = 500;

/* ----- Files a memory names ----- */
const EXT = 'tsx?|jsx?|mjs|cjs|json|md|css|scss|less|html?|py|rs|go|java|cs|cpp|cc|c|h|hpp|toml|ya?ml|sh|ps1|sql|txt|lua|rb|php|kt|swift|vue|svelte|xml|ini|lock|cfg|gradle|csproj|sln';
const FILE_RE = new RegExp(`(?:^|[\\s\`'"(\\[])((?:[\\w.@-]+[\\\\/])*[\\w@-][\\w.@-]*\\.(?:${EXT}))(?=$|[\\s\`'"),:;\\]]|\\.(?:\\s|$))`, 'gi');
export function filesIn(text: string): string[] {
  const clean = text.replace(/\b[a-z][\w+.-]*:\/\/\S+/gi, ' ');
  const out = new Set<string>();
  for (const m of clean.matchAll(FILE_RE)) out.add(m[1].replace(/\\/g, '/').replace(/^\.\//, ''));
  return [...out];
}

/* ----- Splitting a summary into memories ----- */
type Section = Kind | 'files' | 'skip';
function sectionOf(heading: string): Section {
  const h = heading.toLowerCase();
  if (/user messages?/.test(h)) return 'skip';
  if (/files?|code sections?/.test(h)) return 'files';
  if (/pending|next step|to ?do|remaining|open (?:items|questions)/.test(h)) return 'task';
  if (/error|fix|problem|decision|solv/.test(h)) return 'decision';
  return 'fact';
}
// Kind from the words alone, for summaries without headings (Codex's, the local loop's).
function kindOf(text: string): Kind {
  if (/\b(?:decided|decision|chose|chosen|instead of|switched to|went with|fixed|because|so that)\b/i.test(text)) return 'decision';
  if (/^(?:next|todo|to do)\b|\b(?:still need|pending|remaining|follow[- ]up|not yet done|left to do)\b/i.test(text)) return 'task';
  return 'fact';
}
const looksLikeCode = (t: string) => /^(?:const|let|var|function|import|export|return|class|def|if|for)\b|[;{}]\s*$|=>/.test(t);
// Gemini (Antigravity) bolds them: **Facts:** or **Facts**:
const HEADING = /^\s*(?:#{1,6}\s+|\d+\.\s+)?(?:\*\*|__)?([A-Z][^:*_]{1,60}?)(?:\*\*|__)?:(?:\*\*|__)?\s*$/;
const PREAMBLE = /^(?:this session is being continued|summary:?$|the conversation is summarized below|analysis:?$)/i;
// Long lines are cut at sentence ends to fit MAX_TEXT.
function pieces(text: string): string[] {
  if (text.length <= MAX_TEXT) return [text];
  const out: string[] = [];
  let cur = '';
  for (const s of text.split(/(?<=[.!?])\s+/)) {
    if (cur && cur.length + s.length + 1 > MAX_TEXT) { out.push(cur); cur = ''; }
    cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out.map(s => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s));
}

export function extractMemories(summary: string): { kind: Kind; text: string }[] {
  const body = String(summary ?? '')
    .replace(/<analysis>[\s\S]*?<\/analysis>/gi, '')
    .replace(/<\/?summary>/gi, '')
    .replace(/```[\s\S]*?(?:```|$)/g, '');
  const out: { kind: Kind; text: string }[] = [];
  const seen = new Set<string>();
  const push = (kind: Kind, text: string) => {
    const key = `${kind}\n${text.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, text });
  };
  let section: Section | null = null;
  let file: string | null = null; // in a Files section: the file the lines below belong to
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || PREAMBLE.test(line)) continue;
    const head = HEADING.exec(line);
    if (head && !/^[-*•]\s/.test(line)) { section = sectionOf(head[1]); file = null; continue; }
    if (section === 'skip') continue;
    let text = line.replace(/^(?:[-*•+]|\d+[.)])\s+/, '').replace(/\s+/g, ' ').trim();
    text = text.replace(/^\*\*(.+?)\*\*:?\s*/, '$1: ').replace(/`/g, '').trim();
    if (text.length < 8 || text.split(' ').length < 2 && !filesIn(text).length) continue;
    if (looksLikeCode(text)) continue;
    const named = filesIn(text);
    for (const f of named) push('file', f);
    if (section === 'files') {
      // A line that only names a file starts that file's notes.
      if (named.length === 1 && text.replace(/[:\s]+$/, '') === named[0]) { file = named[0]; continue; }
      if (file && !named.length) text = `${file}: ${text}`;
    }
    const kind: Kind = !section || section === 'files' ? kindOf(text) : section;
    for (const p of pieces(text)) if (!memoryRefusal(p)) push(kind, p);
  }
  return out;
}

/* ----- Links ----- */
const STOP = new Set('the and for are but not you all any can had her was one our out has his how its may new now old see two way who did get let put say she too use this that with have from they will been were what when your which their there about would these other into more some than them then only also just like very much such most made over after while where every could should because before through being here those many each does done used using file files code line lines added changed make makes made need needs want wants still work works'.split(' '));
const wordsOf = (text: string) => new Set((text.toLowerCase().replace(/\S+\.(?:\w{1,6})\b/g, ' ').match(/[\p{L}\p{N}_]{3,}/gu) ?? []).filter(w => !STOP.has(w) && !/^\d+$/.test(w)));

export function buildLinks(nodes: BrainNode[], maxPerNode = MAX_LINKS, minJaccard = MIN_JACCARD): BrainLink[] {
  const fileId = new Map(nodes.filter(n => n.kind === 'file').map(n => [n.text.toLowerCase(), n.id]));
  const mems = nodes.filter(n => n.kind !== 'file');
  const info = mems.map(n => ({ n, words: wordsOf(n.text), files: new Set(filesIn(n.text).map(f => f.toLowerCase())) }));
  const cands = new Map<string, { other: string; w: number }[]>();
  const offer = (a: string, b: string, w: number) => {
    if (!cands.has(a)) cands.set(a, []);
    cands.get(a)!.push({ other: b, w });
  };
  for (const x of info) for (const f of x.files) { const id = fileId.get(f); if (id) { offer(x.n.id, id, 1); offer(id, x.n.id, 1); } }
  for (let i = 0; i < info.length; i++) {
    for (let j = i + 1; j < info.length; j++) {
      const a = info[i], b = info[j];
      let w = 0;
      for (const f of a.files) if (b.files.has(f)) { w = 0.8; break; }
      if (!w && a.words.size && b.words.size) {
        let shared = 0;
        const [s, l] = a.words.size < b.words.size ? [a.words, b.words] : [b.words, a.words];
        for (const t of s) if (l.has(t)) shared++;
        const jac = shared / (a.words.size + b.words.size - shared);
        if (shared >= 2 && jac >= minJaccard) w = jac * 0.7;
      }
      if (w) { offer(a.n.id, b.n.id, w); offer(b.n.id, a.n.id, w); }
    }
  }
  // Each node keeps its strongest few; a link stays when either end kept it.
  const kept = new Map<string, BrainLink>();
  for (const [id, list] of cands) {
    for (const c of list.sort((p, q) => q.w - p.w).slice(0, maxPerNode)) {
      const [a, b] = id < c.other ? [id, c.other] : [c.other, id];
      const k = `${a}|${b}`;
      if (!kept.has(k)) kept.set(k, { a, b, w: +c.w.toFixed(3) });
    }
  }
  return [...kept.values()];
}

/* ----- Agents' logs ----- */
const textOf = (content: unknown): string => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(c => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : '')).join('\n') : '';
const parse = (line: string): Record<string, any> | null => { try { return JSON.parse(line); } catch { return null; } };
// Claude Code's session log: the newest summary it wrote when it compacted.
export function claudeCompactSummary(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('isCompactSummary')) continue;
    const d = parse(lines[i]);
    if (d?.isCompactSummary) { const t = textOf(d.message?.content).trim(); if (t) return t; }
  }
  return null;
}
// Codex's rollout log: every summary it wrote when it compacted.
export function codexCompactions(lines: string[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    if (!l.includes('"compacted"')) continue;
    const d = parse(l);
    if (d?.type === 'compacted' && typeof d.payload?.message === 'string' && d.payload.message.trim()) out.push(d.payload.message.trim());
  }
  return out;
}
// Breeze's local loop: the replies compactHistory dropped from a request.
export function droppedReplies(before: { role: string; content?: unknown }[], after: { role: string; content?: unknown }[]): string[] {
  const kept = new Set(after.filter(m => m.role === 'assistant').map(m => textOf(m.content)));
  return before.filter(m => m.role === 'assistant').map(m => textOf(m.content).trim()).filter(t => t && !kept.has(t));
}
/* ----- Summarize: an agent reads the folder's chats and writes what is worth remembering ----- */
// `from`: where in the whole chat `text` starts (BrainStore.newText).
export interface ChatText { key: string; title: string; text: string; from?: number }
export const SUMMARY_CHUNK = 60_000; // characters per request, about 15k tokens
export const SUMMARY_MAX_CHUNKS = 6; // per press; the rest waits for the next one
// Chats cut into requests of at most `max` characters. `upTo`: how far into each whole chat a chunk reaches.
export function summaryChunks(chats: ChatText[], max = SUMMARY_CHUNK): { text: string; upTo: Record<string, number> }[] {
  const out: { text: string; upTo: Record<string, number> }[] = [];
  let cur = { text: '', upTo: {} as Record<string, number> };
  const flush = () => { if (cur.text) out.push(cur); cur = { text: '', upTo: {} }; };
  for (const c of chats) {
    let at = 0;
    while (at < c.text.length) {
      const head = `\n## ${c.title.slice(0, 80)}${at ? ' (continued)' : ''}\n`;
      const room = max - cur.text.length - head.length;
      if (room < Math.min(2000, max / 4) && cur.text) { flush(); continue; }
      const part = c.text.slice(at, at + Math.max(room, 1));
      cur.text += head + part;
      at += part.length;
      cur.upTo[c.key] = (c.from ?? 0) + at;
    }
  }
  flush();
  return out;
}
export function summarizePrompt(chats: string): string {
  return `Below are chat transcripts between a developer and coding agents, all about one project folder. Write down what is worth remembering about the project and how the developer likes to work, as short bullets: one fact each, under 200 characters, no code, no secrets, no small talk. Use exactly these headings and nothing else:

Facts:
Decisions:
Pending Tasks:
Files:

Under Files, name each important file by its path, then a colon and what it is for. Skip a heading with nothing under it.

Reply with only the headings and bullets: no text before or after them, and don't write any file or plan.

<chats>${chats}
</chats>`;
}

// A memory's id: the same kind and words always get the same one, so adding it again finds it.
const nodeId = (kind: Kind, text: string) => crypto.createHash('sha1').update(`${kind}\n${text.toLowerCase()}`).digest('hex').slice(0, 12);

/* ----- What agents can do with it (Breeze's MCP server and the local loop, main.ts) ----- */
export const BRAIN_TOOL_DEFS = [
  {
    name: 'second_brain_search',
    description: "Search what earlier chats in this project learned (facts, decisions, open tasks, what files are for), with linked memories. Use it before working on a part you haven't seen in this chat, or when the user mentions an earlier chat.",
    schema: { type: 'object', properties: { query: { type: 'string', description: 'Words or a file path' }, limit: { type: 'integer', description: '8 by default' } }, required: ['query'] },
  },
  {
    name: 'second_brain_remember',
    description: 'Save one lasting memory for later chats: a fact, a decision and why, an open task, or what a file is for. One short sentence, never code, keys or passwords. Link it with related ids from second_brain_search.',
    schema: { type: 'object', properties: { text: { type: 'string' }, kind: { type: 'string', enum: ['fact', 'decision', 'task'] }, related: { type: 'array', items: { type: 'string' } } }, required: ['text'] },
  },
];
export interface SearchHit { node: BrainNode; linked: BrainNode[] }
const line = (n: BrainNode) => `[${n.id}] (${n.kind}) ${n.text}`;
export function formatSearch(hits: SearchHit[]): string {
  if (!hits.length) return 'Nothing in the second brain matches that yet.';
  return hits.map(h => [line(h.node), ...h.linked.map(n => `    linked: ${line(n)}`)].join('\n')).join('\n');
}

export const summaryKey = (text: string) => crypto.createHash('sha1').update(text.trim()).digest('hex').slice(0, 16);

/* ----- Kept in the project: <folder>/.breezecode ----- */
// Private to this computer: main.ts lists it in the repository's .git/info/exclude, so git never picks it up.
export const BRAIN_DIR = '.breezecode';
const KINDS: Kind[] = ['fact', 'decision', 'task', 'file'];
const cleanNodes = (v: unknown): BrainNode[] => (Array.isArray(v) ? v : [])
  .filter(n => n && typeof n.text === 'string' && typeof n.id === 'string' && KINDS.includes(n.kind))
  .map(n => {
    const chats = Array.isArray(n.chats) ? n.chats.filter((c: unknown) => typeof c === 'string') : null;
    return { id: n.id, kind: n.kind, text: n.text, at: Number(n.at) || 0, agent: String(n.agent ?? ''), hits: Number(n.hits) || 1, ...(chats?.length ? { chats } : {}) };
  });
// Written beside the file and then swapped in, so a crash mid-write leaves the old file whole.
function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch { /* gone */ } throw e; }
}
const BRAIN_MD_LINKS = 3; // linked memories shown under each one in brain.md
const MD_SECTIONS: [Kind, string][] = [['decision', 'Decisions'], ['task', 'Open tasks'], ['fact', 'Facts'], ['file', 'Files']];
// The brain as text for any agent: memories by kind (most used first), each with its id and its strongest links.
export function brainMarkdown(g: Graph): string {
  const byId = new Map(g.nodes.map(n => [n.id, n]));
  // Each memory's strongest few links, found in one pass (a brain can hold well over 100,000 links).
  const top = new Map<string, BrainLink[]>();
  const keep = (id: string, l: BrainLink) => {
    const list = top.get(id) ?? [];
    if (list.length < BRAIN_MD_LINKS) list.push(l);
    else if (l.w > list[list.length - 1].w) list[list.length - 1] = l;
    else return;
    list.sort((a, b) => b.w - a.w);
    top.set(id, list);
  };
  for (const l of g.links) { keep(l.a, l); keep(l.b, l); }
  const out = [
    '# Second brain',
    '',
    'What Breeze Code remembers about this project from earlier chats: facts, decisions and why, open tasks, and what files are for.',
    'Each memory has an id in [brackets]; "linked" lists the memories it connects to. Breeze Code rewrites this file, so edits here are lost.',
    'Agents: read this for context. With Breeze\'s tools, add memories with second_brain_remember instead of editing this file.',
  ];
  if (!g.nodes.length) out.push('', '_Nothing remembered yet._');
  for (const [kind, title] of MD_SECTIONS) {
    const list = g.nodes.filter(n => n.kind === kind).sort((a, b) => b.hits - a.hits || b.at - a.at);
    if (!list.length) continue;
    out.push('', `## ${title}`, '');
    for (const n of list) {
      out.push(`- [${n.id}] ${n.text.replace(/\s+/g, ' ')}`);
      const linked = (top.get(n.id) ?? []).map(l => byId.get(l.a === n.id ? l.b : l.a)).filter((m): m is BrainNode => !!m);
      for (const m of linked) out.push(`  - linked: [${m.id}] ${m.text.replace(/\s+/g, ' ').slice(0, 120)}`);
    }
  }
  return `${out.join('\n')}\n`;
}

/* ----- The store ----- */
export class BrainStore {
  #file: string | null;
  #platform: string;
  #folders: Record<string, BrainNode[]> = {};
  #seen: string[] = [];

  // writeDelay: a project's files are written once changes stop for this long (ms), so a burst of memories is one
  // write; 0 writes at once. flush() writes what is still waiting (main.ts calls it before quitting).
  #writeDelay: number;
  #pending = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(file: string | null, platform: string = process.platform, { writeDelay = 0 }: { writeDelay?: number } = {}) {
    this.#file = file;
    this.#platform = platform;
    this.#writeDelay = writeDelay;
    if (!file) return;
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (j && typeof j.folders === 'object') {
        for (const [k, v] of Object.entries(j.folders)) if (Array.isArray(v)) this.#folders[k] = cleanNodes(v);
      }
      if (Array.isArray(j?.seen)) this.#seen = j.seen.filter((s: unknown) => typeof s === 'string');
      if (j?.read && typeof j.read === 'object') this.#read = j.read;
      if (j?.edges && typeof j.edges === 'object') this.#edges = j.edges;
    } catch { /* no brain yet */ }
  }
  // How much of each chat Summarize already read, per folder: scope -> chat key -> characters.
  #read: Record<string, Record<string, number>> = {};
  // Links agents made between memories, per folder.
  #edges: Record<string, [string, string][]> = {};
  // Folders whose brain lives in the folder itself (<folder>/.breezecode), by scope. The rest stay in the app-data file.
  #homes = new Map<string, string>();
  // Scopes whose folder was already looked at for a .breezecode brain.
  #looked = new Set<string>();

  // The scope of `folder`, its brain loaded from .breezecode the first time. A brain still in the app-data file
  // (from before .breezecode) joins it there and leaves the app-data file. A folder that doesn't exist, or that
  // can't be written, keeps its brain in the app-data file.
  #scope(folder: string): string {
    const scope = scopeOf(folder, this.#platform);
    if (this.#looked.has(scope)) return scope;
    this.#looked.add(scope);
    try { if (!fs.statSync(folder).isDirectory()) return scope; } catch { return scope; }
    const dir = path.join(folder, BRAIN_DIR), file = path.join(dir, 'brain.json');
    let j: Record<string, any> | null = null;
    try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
      // Damaged (cut short by a crash, or edited by hand): kept aside so nothing is lost, then written afresh.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') { try { fs.renameSync(file, `${file}.broken-${Date.now()}`); } catch { /* left as it is */ } }
    }
    const fromApp = this.#folders[scope] ?? [], edgesFromApp = this.#edges[scope] ?? [], readFromApp = this.#read[scope] ?? {};
    const nodes = cleanNodes(j?.nodes);
    const have = new Set(nodes.map(n => n.id));
    this.#folders[scope] = [...nodes, ...fromApp.filter(n => !have.has(n.id))];
    const edges = (Array.isArray(j?.edges) ? j!.edges : []).filter((e: unknown) => Array.isArray(e) && e.length === 2 && e.every(x => typeof x === 'string'));
    for (const e of edgesFromApp) if (!edges.some((x: [string, string]) => x[0] === e[0] && x[1] === e[1])) edges.push(e);
    this.#edges[scope] = edges;
    this.#read[scope] = { ...readFromApp, ...(j?.read && typeof j.read === 'object' ? j.read : {}) };
    try {
      fs.mkdirSync(dir, { recursive: true });
      this.#homes.set(scope, folder);
      this.#writeProject(scope);
    } catch {
      this.#homes.delete(scope);
      return scope;
    }
    if (fromApp.length || edgesFromApp.length || Object.keys(readFromApp).length) this.#saveApp(); // it left the app-data file
    return scope;
  }

  // The folder was renamed or moved (projectmove.ts). Its .breezecode went with it; what the app-data file kept under
  // the old path (memories, links, how far Summarize read) joins the new path. Call it before open(to).
  moveFolder(from: string, to: string): boolean {
    const a = scopeOf(from, this.#platform), b = scopeOf(to, this.#platform);
    if (a === b) return false;
    const nodes = this.#folders[a], edges = this.#edges[a], read = this.#read[a];
    if (!nodes && !edges && !read) return false;
    const have = new Set((this.#folders[b] ?? []).map(n => n.id));
    if (nodes) this.#folders[b] = [...(this.#folders[b] ?? []), ...nodes.filter(n => !have.has(n.id))];
    if (edges) {
      const list = this.#edges[b] ??= [];
      for (const e of edges) if (!list.some(x => x[0] === e[0] && x[1] === e[1])) list.push(e);
    }
    if (read) this.#read[b] = { ...read, ...(this.#read[b] ?? {}) };
    delete this.#folders[a]; delete this.#edges[a]; delete this.#read[a];
    this.#looked.delete(a); this.#homes.delete(a);
    // Already open at the new path this run: its project files get what came over too.
    if (this.#homes.has(b)) this.#save(b);
    this.#saveApp();
    return true;
  }

  // Makes the folder's .breezecode (with its brain, empty or not). Its path, or null when the brain stays in app data.
  open(folder: string): string | null {
    const scope = this.#scope(folder);
    const home = this.#homes.get(scope);
    return home ? path.join(home, BRAIN_DIR) : null;
  }

  #save(scope: string): void {
    if (!this.#homes.has(scope)) { this.#saveApp(); return; }
    if (!this.#writeDelay) { this.#saveProject(scope); return; }
    clearTimeout(this.#pending.get(scope));
    const t = setTimeout(() => { this.#pending.delete(scope); this.#saveProject(scope); }, this.#writeDelay);
    t.unref?.();
    this.#pending.set(scope, t);
  }
  #saveProject(scope: string): void {
    try { this.#writeProject(scope); } catch { this.#homes.delete(scope); this.#saveApp(); } // can't be written any more: app data
  }
  flush(): void {
    for (const [scope, t] of [...this.#pending]) { clearTimeout(t); this.#pending.delete(scope); this.#saveProject(scope); }
  }
  // The app-data file: what was seen, and the brains of folders without a .breezecode.
  #saveApp(): void {
    if (!this.#file) return;
    const pick = <T>(all: Record<string, T>) => Object.fromEntries(Object.entries(all).filter(([k]) => !this.#homes.has(k)));
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      writeAtomic(this.#file, JSON.stringify({ folders: pick(this.#folders), seen: this.#seen, read: pick(this.#read), edges: pick(this.#edges) }));
    } catch { /* best effort */ }
  }
  // <folder>/.breezecode/brain.json (what Breeze reads back, links included for anyone reading it) and brain.md
  // (the same as text, for any agent to read). Throws when the folder can't be written.
  #writeProject(scope: string): void {
    const home = this.#homes.get(scope)!;
    const dir = path.join(home, BRAIN_DIR);
    const g = this.#graphOf(scope);
    writeAtomic(path.join(dir, 'brain.json'), JSON.stringify({
      version: 1,
      about: 'Breeze Code\'s second brain for this project: memories (nodes) and how they connect (links). Written by Breeze Code; brain.md is the same as text.',
      nodes: g.nodes, links: g.links, edges: this.#edges[scope] ?? [], read: this.#read[scope] ?? {},
    }));
    writeAtomic(path.join(dir, 'brain.md'), brainMarkdown(g));
  }

  // Chats deleted this session: a summary of one still being written when it went is dropped, not kept.
  #forgotten = new Set<string>();

  #add(folder: string, items: { kind: Kind; text: string }[], agent: string, now: number, chats?: string[]): number {
    if (chats) {
      chats = chats.filter(k => !this.#forgotten.has(k));
      if (!chats.length) return 0;
    }
    const scope = this.#scope(folder);
    const list = this.#folders[scope] ??= [];
    const byId = new Map(list.map(n => [n.id, n]));
    const done = new Set<string>();
    for (const it of items) {
      const id = nodeId(it.kind, it.text);
      if (done.has(id)) continue;
      done.add(id);
      const old = byId.get(id);
      if (old) {
        old.hits++;
        old.at = now;
        if (!chats) delete old.chats; // said somewhere that is no chat too: it stays
        else if (old.chats) old.chats = [...new Set([...old.chats, ...chats])];
        continue;
      }
      const n: BrainNode = { id, kind: it.kind, text: it.text, at: now, agent, hits: 1, ...(chats ? { chats: [...chats] } : {}) };
      list.push(n);
      byId.set(id, n);
    }
    if (list.length > MAX_NODES) {
      const drop = new Set([...list].sort((a, b) => a.hits - b.hits || a.at - b.at).slice(0, list.length - MAX_NODES));
      this.#folders[scope] = list.filter(n => !drop.has(n));
    }
    if (done.size) this.#save(scope);
    return done.size;
  }

  // A compaction summary: split, typed and kept. Returns how many memories were added or seen again.
  // `chats`: the chats it came from (see BrainNode).
  addSummary(folder: string, summary: string, agent: string, now = Date.now(), chats?: string[]): number {
    return this.#add(folder, extractMemories(summary), agent, now, chats);
  }
  // Loose texts (the local loop's dropped replies): each is split like a summary without headings.
  addFacts(folder: string, texts: string[], agent: string, now = Date.now(), chats?: string[]): number {
    return this.#add(folder, texts.flatMap(t => extractMemories(t)), agent, now, chats);
  }
  graph(folder: string): Graph {
    return this.#graphOf(this.#scope(folder));
  }
  // How many memories the folder has, without working out the links.
  count(folder: string): number {
    return (this.#folders[this.#scope(folder)] ?? []).length;
  }
  #graphOf(scope: string): Graph {
    const nodes = (this.#folders[scope] ?? []).map(n => ({ ...n }));
    const links = buildLinks(nodes);
    // Links agents made (second_brain_remember), on top of the ones found from files and words.
    const ids = new Set(nodes.map(n => n.id)), have = new Set(links.map(l => `${l.a}|${l.b}`));
    for (const [a, b] of this.#edges[scope] ?? []) {
      if (!ids.has(a) || !ids.has(b) || have.has(`${a}|${b}`)) continue;
      have.add(`${a}|${b}`);
      links.push({ a, b, w: 1 });
    }
    return { nodes, links };
  }
  // The memories that best match `query` (shared words, a named file, the whole phrase), each with its strongest links.
  search(folder: string, query: string, limit = 8): SearchHit[] {
    const g = this.graph(folder);
    const q = String(query ?? '').trim().toLowerCase();
    if (!q) return [];
    const qw = wordsOf(q), qf = filesIn(q).map(f => f.toLowerCase());
    const scored = g.nodes.map(n => {
      const t = n.text.toLowerCase();
      let s = 0;
      for (const w of wordsOf(t)) if (qw.has(w)) s += 3;
      for (const f of qf) if (t.includes(f)) s += 5;
      if (q.length >= 4 && t.includes(q)) s += 4;
      return { n, s: s ? s + Math.min(n.hits, 5) * 0.3 : 0 };
    }).filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, Math.max(1, Math.min(limit, 30)));
    const byId = new Map(g.nodes.map(n => [n.id, n]));
    const hitIds = new Set(scored.map(x => x.n.id));
    return scored.map(({ n }) => ({
      node: n,
      linked: g.links.filter(l => l.a === n.id || l.b === n.id).sort((a, b) => b.w - a.w)
        .map(l => byId.get(l.a === n.id ? l.b : l.a)!).filter(m => m && !hitIds.has(m.id)).slice(0, 3),
    }));
  }
  // An agent's own memory (second_brain_remember), linked to the memories it names. Throws why it can't be kept.
  remember(folder: string, text: string, kind: unknown, related: unknown, agent: string, now = Date.now(), chats?: string[]): BrainNode {
    const why = memoryRefusal(String(text ?? ''));
    if (why) throw new Error(why);
    const clean = String(text).trim().replace(/\s+/g, ' ');
    const k: Kind = kind === 'decision' || kind === 'task' ? kind : 'fact';
    if (chats?.length && chats.every(c => this.#forgotten.has(c))) throw new Error('This chat was deleted, so nothing from it is kept.');
    this.#add(folder, [{ kind: k, text: clean }, ...filesIn(clean).map(f => ({ kind: 'file' as Kind, text: f }))], agent, now, chats);
    const scope = this.#scope(folder);
    const id = nodeId(k, clean);
    const ids = new Set((this.#folders[scope] ?? []).map(n => n.id));
    const edges = this.#edges[scope] ??= [];
    for (const r of (Array.isArray(related) ? related : []).slice(0, MAX_LINKS)) {
      if (typeof r !== 'string' || r === id || !ids.has(r)) continue;
      const pair: [string, string] = r < id ? [r, id] : [id, r];
      if (!edges.some(e => e[0] === pair[0] && e[1] === pair[1])) edges.push(pair);
    }
    this.#save(scope);
    return { ...(this.#folders[scope] ?? []).find(n => n.id === id)! };
  }
  remove(folder: string, id: string): boolean {
    const scope = this.#scope(folder);
    const list = this.#folders[scope] ?? [];
    const next = list.filter(n => n.id !== id);
    if (next.length === list.length) return false;
    this.#folders[scope] = next;
    if (this.#edges[scope]) this.#edges[scope] = this.#edges[scope].filter(e => e[0] !== id && e[1] !== id);
    this.#save(scope);
    return true;
  }
  // Chats deleted: what only they said goes, with links agents made to it and how far Summarize had read them.
  // Returns the folders whose memories changed.
  forgetChats(keys: string[]): string[] {
    const gone = new Set(keys);
    for (const k of gone) this.#forgotten.add(k);
    const changed: string[] = [];
    for (const [scope, list] of Object.entries(this.#folders)) {
      const drop = new Set<string>();
      let touched = false;
      for (const n of list) {
        if (!n.chats?.some(k => gone.has(k))) continue;
        touched = true;
        n.chats = n.chats.filter(k => !gone.has(k));
        if (!n.chats.length) drop.add(n.id);
      }
      if (!touched) continue;
      this.#folders[scope] = list.filter(n => !drop.has(n.id));
      if (this.#edges[scope]) this.#edges[scope] = this.#edges[scope].filter(e => !drop.has(e[0]) && !drop.has(e[1]));
      changed.push(scope);
    }
    // Each folder's brain is saved where it lives (.breezecode or the app-data file).
    const save = new Set(changed);
    for (const [scope, r] of Object.entries(this.#read)) for (const k of gone) if (k in r) { delete r[k]; save.add(scope); }
    for (const scope of save) this.#save(scope);
    return changed;
  }
  // The part of each chat Summarize hasn't read yet. A chat that got shorter (edited) is read again from its start.
  newText(folder: string, chats: ChatText[]): ChatText[] {
    const read = this.#read[this.#scope(folder)] ?? {};
    return chats.map(c => {
      const from = (read[c.key] ?? 0) <= c.text.length ? read[c.key] ?? 0 : 0;
      return { ...c, text: c.text.slice(from), from };
    }).filter(c => c.text.trim());
  }
  // `upTo`: how far into each whole chat has now been summarized (summaryChunks' upTo).
  markRead(folder: string, upTo: Record<string, number>): void {
    const scope = this.#scope(folder);
    const read = this.#read[scope] ??= {};
    for (const [k, n] of Object.entries(upTo)) if (!this.#forgotten.has(k)) read[k] = n;
    this.#save(scope);
  }
  // True when `key` (a summary's hash) was taken before; otherwise it is noted and false comes back.
  seen(key: string): boolean {
    if (this.#seen.includes(key)) return true;
    this.#seen.push(key);
    if (this.#seen.length > MAX_SEEN) this.#seen.splice(0, this.#seen.length - MAX_SEEN);
    this.#saveApp();
    return false;
  }
}
