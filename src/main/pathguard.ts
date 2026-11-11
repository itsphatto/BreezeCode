// Path checks that keep file access inside a folder. Plain functions with no Electron, so test/pathguard.test.js can cover them.
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

// True when `abs` is `base` or inside it, compared by path only.
function isInside(base: string, abs: string): boolean {
  const back = path.relative(base, abs);
  return !(back === '..' || back.startsWith(`..${path.sep}`) || path.isAbsolute(back));
}

// Resolve a path inside `base` and refuse anything that escapes it.
function resolveUnder(base: string, rel: unknown = ''): string {
  const abs = path.resolve(base, String(rel));
  if (!isInside(base, abs)) throw new Error('That path is outside the project');
  return abs;
}

// The nearest part of `abs` that exists, with symlinks and junctions followed.
async function realExisting(abs: string): Promise<string> {
  for (let p = abs; ; p = path.dirname(p)) {
    try { return path.join(await fsp.realpath(p), path.relative(p, abs)); } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
      if (path.dirname(p) === p) return abs;
    }
  }
}

// Like resolveUnder, but also refuses a path that a symlink or junction inside `base` points outside it.
async function resolveReal(base: string, rel: unknown = ''): Promise<string> {
  const abs = resolveUnder(base, rel);
  const [realBase, realAbs] = await Promise.all([fsp.realpath(base), realExisting(abs)]);
  if (!isInside(realBase, realAbs)) throw new Error('That path links outside the project');
  return abs;
}

// True when `abs` is in the git folder of `base`. Writing there (hooks, config) can run code on the next git command.
// Windows ignores trailing dots and spaces, and may also know the folder by its short name.
function isGitPath(base: string, abs: string): boolean {
  return path.relative(base, abs).split(/[\\/]/).some(part => {
    const name = part.toLowerCase().replace(/[. ]+$/, '');
    return name === '.git' || name === 'git~1';
  });
}

// True when `url` is the page `file` (a file:// URL), with any query or hash. Windows paths ignore case.
function isPageUrl(url: unknown, file: string, platform: string = process.platform): boolean {
  const key = (u: unknown) => { const d = decodeURI(String(u).split(/[?#]/)[0]); return platform === 'win32' ? d.toLowerCase() : d; };
  try { return typeof url === 'string' && key(url) === key(file); } catch { return false; } // a malformed URL is never the page
}

export { isInside, resolveUnder, resolveReal, isGitPath, isPageUrl };
