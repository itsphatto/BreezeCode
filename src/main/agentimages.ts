// Pictures an agent shows the user: an image file it wrote, named in its reply or a command's output, or asked to
// show (show_image). Plain functions with no Electron, so test/agentimages.test.js can cover them.
import * as path from 'node:path';
import { resolveUnder, agentBlocked } from './guard';

const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|svg)$/i;
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const MAX_PER_SCAN = 6;
const NOT_IMAGE = 'Only png, jpg, gif, webp or svg pictures can be shown.';

// Paths to pictures written in a piece of text: bare, in `backticks`, in quotes or as ![alt](path). Web addresses are
// left out (they are not files here), and so is anything with a wildcard in it ("*.png" is a pattern, not a file).
// The end of a path is a space, a quote or bracket, or punctuation that ends the sentence.
const PATH_IN_TEXT = /(?:[A-Za-z]:[\\/]|\.{0,2}[\\/])?[^\s"'`()<>[\]|*?{}]*?[^\s"'`()<>[\]|*?{}\\/:]\.(?:png|jpe?g|gif|webp|svg)(?=$|[\s"'`)\]>,;!?]|[.:](?:\s|$))/gi;
function imagePathsIn(text: unknown, max = MAX_PER_SCAN): string[] {
  const out: string[] = [];
  for (const m of String(text ?? '').matchAll(PATH_IN_TEXT)) {
    const start = m.index ?? 0;
    const before = String(text).slice(Math.max(0, start - 8), start);
    if (/[a-z][\w+.-]*:\/*$/i.test(before) || /\/\/|^[a-z][\w+.-]+:\/\//i.test(m[0])) continue; // part of a URL
    const p = m[0].replace(/^\.[\\/]/, '');
    if (!p || out.includes(p)) continue;
    out.push(p);
    if (out.length >= max) break;
  }
  return out;
}

// Why `abs` can't be shown, or null when it can. The rules the agent's file tools keep: inside the project, never
// a .env file or the .git folder. Full access lifts them. `extra`: folders that are always fine (the screenshot stash).
function imageRefusal(base: string, abs: string, { full = false, extra = [] as string[] } = {}): string | null {
  if (!IMAGE_EXT.test(abs)) return NOT_IMAGE;
  if (full) return null;
  for (const dir of extra) {
    const rel = path.relative(dir, abs);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return null;
  }
  try { resolveUnder(base, path.relative(base, abs)); } catch (err) { return (err as Error).message; }
  return agentBlocked(base, abs);
}

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const imageMime = (p: string): string => MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream';

export { IMAGE_EXT, IMAGE_MAX_BYTES, NOT_IMAGE, imagePathsIn, imageRefusal, imageMime };
