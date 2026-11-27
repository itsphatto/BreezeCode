// Agentic tasks' memory: short facts about the user and each project, kept on this computer only.
// Plain functions and a class with no Electron, so test/agentmemory.test.js can cover them.
// A fact belongs to one project or to everything ('global'). A project's facts never reach another project's
// prompts. Nothing that looks like a key, password or file dump is kept.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { looksLikeSecret } from './deviceguard';

export interface Memory { id: string; scope: string; text: string; at: number; used: number }
export const GLOBAL = 'global';
export const MAX_TEXT = 300;
export const MAX_PER_SCOPE = 200;

// Project scopes are the folder's path, compared without case on Windows.
export const scopeOf = (project: string | null | undefined, platform: string = process.platform): string =>
  !project ? GLOBAL : platform === 'win32' ? path.win32.normalize(project).toLowerCase() : path.posix.normalize(project);

// Why a fact can't be kept, or null.
export function memoryRefusal(text: string): string | null {
  const t = text.trim();
  if (!t) return 'There is nothing to remember.';
  if (t.length > MAX_TEXT) return `Keep a memory under ${MAX_TEXT} characters: one fact, not a file.`;
  if (looksLikeSecret(t) || /\b(?:password|passwd|api[_ -]?key|secret|token)\s*[:=]\s*\S+/i.test(t)) return 'That looks like a secret. Breeze never remembers keys or passwords.';
  if ((t.match(/\n/g) ?? []).length > 4 || /[{};]\s*\n.*[{};]/s.test(t)) return 'That looks like code or file contents. Remember a short fact instead.';
  return null;
}

const words = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? []);
// How well a fact matches a query: shared words, with a nudge for facts used often and recently.
function score(m: Memory, q: Set<string>, now: number): number {
  let hit = 0;
  for (const w of words(m.text)) if (q.has(w)) hit++;
  const ageDays = (now - m.at) / 86400000;
  return hit * 10 + Math.min(m.used, 10) - Math.min(ageDays / 30, 5);
}

export class MemoryStore {
  #file: string | null;
  #items: Memory[] = [];
  #platform: string;

  constructor(file: string | null, platform: string = process.platform) {
    this.#file = file;
    this.#platform = platform;
    if (file) {
      try {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Array.isArray(j?.items)) this.#items = j.items.filter((m: Memory) => m && typeof m.text === 'string' && typeof m.scope === 'string');
      } catch { /* no memory yet */ }
    }
  }

  #save(): void {
    if (!this.#file) return;
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      fs.writeFileSync(this.#file, JSON.stringify({ items: this.#items }, null, 1));
    } catch { /* best effort */ }
  }

  // The project folder was renamed or moved: its facts go with it (a fact the new path already has isn't doubled).
  moveScope(from: string, to: string): number {
    const a = scopeOf(from, this.#platform), b = scopeOf(to, this.#platform);
    if (a === b || a === GLOBAL) return 0;
    const have = new Set(this.#items.filter(m => m.scope === b).map(m => m.text.toLowerCase()));
    let n = 0, dropped = 0;
    this.#items = this.#items.filter(m => {
      if (m.scope !== a) return true;
      if (have.has(m.text.toLowerCase())) { dropped++; return false; }
      m.scope = b;
      n++;
      return true;
    });
    if (n || dropped) this.#save();
    return n;
  }

  // Keeps a fact; a fact already kept in the same scope is refreshed, not doubled. The oldest least-used goes past the cap.
  add(text: string, project: string | null, now = Date.now()): Memory {
    const why = memoryRefusal(text);
    if (why) throw new Error(why);
    const scope = scopeOf(project, this.#platform);
    const clean = text.trim().replace(/\s+/g, ' ');
    const same = this.#items.find(m => m.scope === scope && m.text.toLowerCase() === clean.toLowerCase());
    if (same) { same.at = now; this.#save(); return same; }
    const m: Memory = { id: crypto.randomBytes(6).toString('hex'), scope, text: clean, at: now, used: 0 };
    this.#items.push(m);
    const inScope = this.#items.filter(x => x.scope === scope);
    if (inScope.length > MAX_PER_SCOPE) {
      const drop = inScope.sort((a, b) => a.used - b.used || a.at - b.at)[0];
      this.#items = this.#items.filter(x => x !== drop);
    }
    this.#save();
    return m;
  }

  // The facts that best match `query`, from this project and global only.
  recall(query: string, project: string | null, limit = 8, now = Date.now()): Memory[] {
    const scopes = new Set([GLOBAL, scopeOf(project, this.#platform)]);
    const q = words(query);
    const found = this.#items.filter(m => scopes.has(m.scope))
      .map(m => ({ m, s: score(m, q, now) }))
      .filter(x => !q.size || x.s > 0 || x.m.scope === GLOBAL)
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map(x => x.m);
    for (const m of found) m.used++;
    if (found.length) this.#save();
    return found;
  }

  // Forgets one fact by id, or every fact in this project's and global scope whose text contains `match`.
  forget(idOrMatch: string, project: string | null): number {
    const scopes = new Set([GLOBAL, scopeOf(project, this.#platform)]);
    const needle = idOrMatch.trim().toLowerCase();
    if (!needle) return 0;
    const before = this.#items.length;
    this.#items = this.#items.filter(m => !(scopes.has(m.scope) && (m.id === idOrMatch || m.text.toLowerCase().includes(needle))));
    const n = before - this.#items.length;
    if (n) this.#save();
    return n;
  }

  list(project?: string | null): Memory[] {
    if (project === undefined) return [...this.#items];
    const scopes = new Set([GLOBAL, scopeOf(project, this.#platform)]);
    return this.#items.filter(m => scopes.has(m.scope));
  }

  clear(): void { this.#items = []; this.#save(); }
  remove(id: string): boolean {
    const before = this.#items.length;
    this.#items = this.#items.filter(m => m.id !== id);
    if (this.#items.length !== before) { this.#save(); return true; }
    return false;
  }

  // The lines that go into a task's prompt: what the tasks know, cut to fit `maxChars`.
  promptBlock(goal: string, project: string | null, maxChars = 1500): string {
    const found = this.recall(goal, project, 20);
    if (!found.length) return '';
    const lines: string[] = [];
    let used = 0;
    for (const m of found) {
      const line = `- ${m.text}${m.scope === GLOBAL ? '' : ' (this project)'}`;
      if (used + line.length + 1 > maxChars) break;
      lines.push(line);
      used += line.length + 1;
    }
    return `What you remember about the user and this project:\n${lines.join('\n')}`;
  }
}
