// A project folder that was renamed or moved: Breeze finds out it is the same project, so its chats, agent sessions
// and second brain follow it instead of staying behind under the old path.
// <folder>/.breezecode/project.json holds an id and the path the folder was last opened at; it travels with the
// folder. Opened somewhere else while the old path is gone: the folder moved. The old path still there: a copy, which
// gets an id of its own. Plain functions with no Electron, so test/projectmove.test.js can cover them.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { scopeOf } from './agentmemory';
import { BRAIN_DIR } from './secondbrain';

export const MARKER = 'project.json';
// `was`: paths the folder had before, newest last.
export interface Marker { id: string; path: string; was: string[] }
const markerFile = (dir: string) => path.join(dir, BRAIN_DIR, MARKER);
const WAS_KEPT = 10;

export function readMarker(dir: string): Marker | null {
  try {
    const j = JSON.parse(fs.readFileSync(markerFile(dir), 'utf8'));
    if (!j || typeof j.id !== 'string' || typeof j.path !== 'string' || !j.id || !j.path) return null;
    return { id: j.id, path: j.path, was: Array.isArray(j.was) ? j.was.filter((w: unknown) => typeof w === 'string' && w) : [] };
  } catch { return null; }
}
export function writeMarker(dir: string, m: Marker): void {
  fs.mkdirSync(path.join(dir, BRAIN_DIR), { recursive: true });
  fs.writeFileSync(markerFile(dir), `${JSON.stringify({
    about: 'Breeze Code: which project this folder is, so its chats and second brain follow it when the folder is renamed or moved.',
    ...m,
  }, null, 2)}\n`);
}

// Notes that `dir` was opened. `moved`: the paths it was at before that are gone now, so what was kept under them
// should follow it. `known(id)`: where this copy of Breeze last saw the project (an installed build and a dev build
// keep their own chats, so each moves its own); without that, every earlier path in the marker counts. When the
// folder Breeze last saw is still there with the same id, `dir` is a copy and becomes a project of its own. A folder
// that can't be written is never seen as moved.
export function noteOpened(dir: string, known: (id: string) => string | undefined = () => undefined, platform: string = process.platform): { id: string | null; moved: string[] } {
  const same = (a: string, b: string) => scopeOf(a, platform) === scopeOf(b, platform);
  const fresh = () => { const id = crypto.randomUUID(); writeMarker(dir, { id, path: dir, was: [] }); return { id, moved: [] }; };
  const m = readMarker(dir);
  try {
    if (!m) return fresh();
    const seen = known(m.id);
    const last = seen ?? m.path;
    if (!same(last, dir) && fs.existsSync(last) && readMarker(last)?.id === m.id) return fresh();
    const was = [...m.was, m.path].filter((p, i, all) => !same(p, dir) && all.findIndex(q => same(q, p)) === i).slice(-WAS_KEPT);
    if (m.path !== dir || was.length !== m.was.length || was.some((p, i) => p !== m.was[i])) writeMarker(dir, { id: m.id, path: dir, was });
    const before = (seen ? [seen] : [...m.was, m.path]).filter((p, i, all) => !same(p, dir) && all.findIndex(q => same(q, p)) === i);
    return { id: m.id, moved: before.filter(p => !fs.existsSync(p)) };
  } catch { return { id: null, moved: [] }; }
}

// `p` with `from` swapped for `to` when it is `from` or inside it; null when it isn't.
export function movedPath(p: string, from: string, to: string, platform: string = process.platform): string | null {
  const win = platform === 'win32';
  const norm = (s: string) => (win ? path.win32.normalize(s).replace(/[\\/]+$/, '') : path.posix.normalize(s).replace(/\/+$/, ''));
  const a = norm(p), f = norm(from);
  const eq = (x: string, y: string) => (win ? x.toLowerCase() === y.toLowerCase() : x === y);
  if (eq(a, f)) return to;
  const sep = win ? '\\' : '/';
  if (a.length > f.length && eq(a.slice(0, f.length), f) && a[f.length] === sep) return to + a.slice(f.length);
  return null;
}

// The recent list with the old path swapped for the new one (once, where the newest of the two was).
export function moveRecent(recent: string[], recentAt: Record<string, number | null> | undefined, from: string, to: string, platform: string = process.platform) {
  const out: string[] = [];
  const at: Record<string, number | null> = {};
  for (const r of recent) {
    const p = movedPath(r, from, to, platform) ?? r;
    const kept = out.find(x => scopeOf(x, platform) === scopeOf(p, platform)) ?? p;
    if (kept === p && !out.includes(p)) out.push(p);
    at[kept] = Math.max(Number(at[kept] ?? 0), Number(recentAt?.[r] ?? 0)) || null;
  }
  return { recent: out, recentAt: at };
}

// Claude Code keeps a folder's sessions in projects/<the path with every other character a dash>, and resumes a
// session only from the folder it runs in.
export const claudeSlug = (p: string) => p.replace(/[^a-zA-Z0-9]/g, '-');
// The old folder's Claude Code sessions, copied (never moved: Claude's own folder stays as it was) to where Claude
// looks for the new one, so a chat that began there carries on. Returns how many sessions were copied.
export function copyClaudeSessions(projects: string, from: string, to: string): number {
  const src = path.join(projects, claudeSlug(from)), dest = path.join(projects, claudeSlug(to));
  if (src === dest) return 0;
  let names: string[];
  try { names = fs.readdirSync(src); } catch { return 0; }
  let n = 0;
  fs.mkdirSync(dest, { recursive: true });
  for (const name of names) {
    const to2 = path.join(dest, name);
    if (fs.existsSync(to2)) continue;
    try {
      fs.cpSync(path.join(src, name), to2, { recursive: true, errorOnExist: false, force: false });
      if (name.endsWith('.jsonl')) n++;
    } catch { /* in use: that one stays where it was */ }
  }
  return n;
}

// Breeze's own local-loop sessions remember the folder they ran in; the ones from the old folder now run in the new.
export function moveLlmSessions(dir: string, from: string, to: string, platform: string = process.platform): number {
  let names: string[];
  try { names = fs.readdirSync(dir).filter(n => n.endsWith('.json')); } catch { return 0; }
  let n = 0;
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      const base = typeof j?.base === 'string' ? movedPath(j.base, from, to, platform) : null;
      if (!base) continue;
      j.base = base;
      fs.writeFileSync(file, JSON.stringify(j));
      n++;
    } catch { /* not one of ours */ }
  }
  return n;
}
