// Pure logic for a project folder that was renamed or moved (main's projectmove.ts finds that out): which saved keys
// and chats follow it to the new path. history.ts applies it to localStorage. No DOM, no globals from other files.

// A Windows path ("C:\…") is compared without case, like the folder itself.
const moveCaseless = (p: string) => /^[a-z]:[\\/]/i.test(p) || p.startsWith('\\\\');
const moveTrim = (p: string) => p.replace(/[\\/]+$/, '');

// `p` with `from` swapped for `to` when it is `from` or inside it; null when it isn't.
function movedFolderPath(p: string, from: string, to: string): string | null {
  const a = moveTrim(p), f = moveTrim(from);
  const head = a.slice(0, f.length);
  if (!(moveCaseless(f) ? head.toLowerCase() === f.toLowerCase() : head === f)) return null;
  if (a.length === f.length) return to;
  return a[f.length] === '\\' || a[f.length] === '/' ? to + a.slice(f.length) : null;
}

// A saved key with the old folder's path in it ("breeze.history:C:\…\Old", "breeze.agentSession:C:\…\Old:claude",
// "breeze.board.C:\…\Old"), renamed for the new one; null when it names no folder or another one.
function movedStorageKey(key: string, from: string, to: string): string | null {
  const f = moveTrim(from);
  const hay = moveCaseless(f) ? key.toLowerCase() : key, needle = moveCaseless(f) ? f.toLowerCase() : f;
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
    const before = key[at - 1], after = key[at + f.length];
    if (before !== ':' && before !== '.') continue;
    if (after !== undefined && after !== ':') continue;
    return key.slice(0, at) + to + key.slice(at + f.length);
  }
  return null;
}

interface MovedChat { id?: unknown; at?: unknown; folder?: unknown }
const isChatList = (v: unknown): v is MovedChat[] => Array.isArray(v) && v.every(e => !!e && typeof e === 'object' && typeof (e as MovedChat).id === 'string');

// Chats filed under the old folder (or inside it) filed under the new one; null when none were.
function moveChatFolders(list: MovedChat[], from: string, to: string): MovedChat[] | null {
  let changed = false;
  const out = list.map(e => {
    const p = typeof e.folder === 'string' ? movedFolderPath(e.folder, from, to) : null;
    if (p == null) return e;
    changed = true;
    return { ...e, folder: p };
  });
  return changed ? out : null;
}

// What to write and remove so everything saved under `from` is under `to`. `items` is every saved key and its value
// (parsed JSON, or the raw text when it isn't JSON). Two chat histories for one folder are merged, newest first; for
// anything else the new path's own value, made since the move, is kept.
function planFolderMove(items: [string, unknown][], from: string, to: string): { set: [string, unknown][]; del: string[] } {
  const have = new Map(items);
  const set = new Map<string, unknown>(), del: string[] = [];
  const current = (k: string) => (set.has(k) ? set.get(k) : have.get(k));
  for (const [key, value] of items) {
    const nk = movedStorageKey(key, from, to);
    if (nk == null || nk === key) continue;
    del.push(key);
    const there = current(nk);
    if (there === undefined) { set.set(nk, value); continue; }
    if (isChatList(there) && isChatList(value)) {
      const ids = new Set(there.map(e => e.id));
      set.set(nk, [...there, ...value.filter(e => !ids.has(e.id))].sort((a, b) => Number(b.at ?? 0) - Number(a.at ?? 0)));
    }
  }
  // Chats elsewhere (Breeze Space's, grouped by folder) that began in the old folder.
  for (const key of new Set([...have.keys(), ...set.keys()])) {
    if (del.includes(key) && !set.has(key)) continue;
    const v = current(key);
    if (!isChatList(v)) continue;
    const moved = moveChatFolders(v, from, to);
    if (moved) set.set(key, moved);
  }
  return { set: [...set], del: del.filter(k => !set.has(k)) };
}
