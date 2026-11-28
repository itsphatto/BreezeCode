// "Trust this repository?": a repository's own git config and hooks can name programs git runs by itself (filters on
// add and status, hooks on commit and checkout, core.sshCommand and credential helpers on fetch and push...). A clone
// never brings those along, but a folder whose .git came from someone else (a zip, a USB stick, a shared drive) does.
// This finds them; until the user trusts the repository, Breeze's git calls that only read run with them switched off,
// and the rest are refused with UNTRUSTED. Trust is kept per repository (main.ts, app state) as a fingerprint of what
// was found, so changed settings or hooks ask again. Plain Node with no Electron, for test/gittrust.test.js.
//
// Nested repositories: git add and commit run `git status` inside every submodule (any gitlink whose folder has its own
// .git directory or .git file), with that repository's config. A call that may run something therefore looks into each
// of them, at any depth, and needs all of them trusted too. Reads never go into them (safeGitArgs, guard.ts), so a
// nested repository that turns up after a look can't run anything through a read.
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { safeGitArgs } from './guard';

// Runs git in `cwd` with `args`, resolving to stdout; a rejection carries git's output on `.stderr`.
export type GitExec = (cwd: string, args: string[]) => Promise<string>;
export interface RiskItem { kind: 'config' | 'hook'; where: string; name: string; detail: string }
export interface RepoRisk {
  repo: string; // the repository's common git folder: the key trust is kept under
  path?: string; // a nested repository's folder, relative to the outermost one, with forward slashes
  items: RiskItem[];
  fingerprint: string;
  drivers: { filter: string[]; diff: string[]; merge: string[]; hook: string[] }; // named drivers and hooks to switch off
  unreadable?: string; // git couldn't list the settings: nothing runs, and this can't be trusted
  nested?: RepoRisk[]; // every nested repository, flattened (only when looked for: inspectRepo's `nested`)
}

const UNTRUSTED = "This repository isn't trusted yet";
const UNTRUSTED_MESSAGE = `${UNTRUSTED}: its git settings or hooks can run programs. Review them in Source Control and choose Trust to let Breeze run git here.`;
class GitTrustError extends Error {}

/* ----- Settings that run programs ----- */
// Keys as `git config --list` prints them: section and name lower case, a subsection as written (matched without case).
// Checked against `git help config` for git 2.55: every key documented as naming a command, program, helper or tool.
const RISKY_KEYS: RegExp[] = [
  /^core\.(?:hookspath|fsmonitor|sshcommand|askpass|editor|pager|gitproxy|alternaterefscommand)$/,
  /^sequence\.editor$/,
  /^credential\.(?:.+\.)?helper$/,
  /^filter\..+\.(?:clean|smudge|process)$/,
  /^diff\.external$/, /^diff\..+\.(?:command|textconv)$/,
  /^merge\..+\.driver$/,
  /^hook\..+\.command$/, // config-defined hooks: core.hooksPath doesn't cover them
  /^gc\.recentobjectshook$/, // run by the automatic gc after commit and fetch
  /^interactive\.difffilter$/,
  /^gpg\.(?:.+\.)?program$/, /^gpg\.ssh\.defaultkeycommand$/,
  /^remote\..+\.(?:uploadpack|receivepack|vcs)$/,
  /^pager\./,
  /^include\.path$/, /^includeif\..+\.path$/, // another file's settings: listed too, as entries of their own
  /^lfs\.customtransfer\..+\.path$/, /^lfs\.extension\..+\.(?:clean|smudge)$/,
  /^trailer\..+\.(?:command|cmd)$/,
  /^ssh\.variant$/,
  /^imap\.tunnel$/,
  /^(?:difftool|mergetool|man|browser)\..+\.(?:cmd|path)$/, /^guitool\..+\.cmd$/, /^web\.browser$/, /^instaweb\.(?:httpd|browser)$/,
  /^sendemail\.(?:.+\.)?(?:sendmailcmd|tocmd|cccmd|headercmd)$/,
];
function riskyKey(key: string, value: string): boolean {
  const k = key.toLowerCase();
  if (/^submodule\..+\.update$/.test(k)) return value.trim().startsWith('!'); // "!command" runs it on submodule update
  if (/^protocol\.(?:ext\.)?allow$/.test(k)) return value.trim().toLowerCase() !== 'never'; // ext:: URLs run commands
  if (/^sendemail\.(?:.+\.)?smtpserver$/.test(k)) return /^(?:[/~]|[a-z]:[\\/])/i.test(value.trim()); // a path is a program
  return RISKY_KEYS.some(re => re.test(k));
}
// Every hook event (githooks(5), git 2.55): `hook.<event>.enabled=false` stops config-defined hooks of any name.
const HOOK_EVENTS = ['applypatch-msg', 'commit-msg', 'fsmonitor-watchman', 'post-applypatch', 'post-checkout', 'post-commit', 'post-index-change',
  'post-merge', 'post-receive', 'post-rewrite', 'post-update', 'pre-applypatch', 'pre-auto-gc', 'pre-commit', 'pre-merge-commit', 'pre-push',
  'pre-rebase', 'pre-receive', 'prepare-commit-msg', 'proc-receive', 'push-to-checkout', 'reference-transaction', 'sendemail-validate', 'update'];

/* ----- Calls that only read ----- */
// These run no hooks and write nothing; with filters and diff drivers off (neutralArgs) they run no program either.
const READ_CMDS = new Set(['status', 'log', 'show', 'diff', 'rev-parse', 'for-each-ref', 'check-ignore', 'check-ref-format', 'ls-files', 'cat-file']);
const BRANCH_LIST = /^(?:--format=.*|--list|--show-current|-a|-r|-v|-vv|--all|--remotes)$/s;
function gitReadOnly(args: string[]): boolean {
  let i = 0;
  while (args[i] === '-c' && i + 1 < args.length) i += 2;
  const [cmd, ...rest] = args.slice(i);
  if (!cmd) return false;
  if (READ_CMDS.has(cmd)) return true;
  if (cmd === 'branch') return rest.every(a => BRANCH_LIST.test(a));
  if (cmd === 'remote') return rest.length === 0 || rest[0] === '-v' || (rest[0] === 'get-url' && rest.length === 2);
  if (cmd === 'worktree') return (rest[0] === 'prune' || rest[0] === 'list') && rest.length === 1; // bookkeeping only
  return false;
}

/* ----- Looking at a repository ----- */
const sha256 = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex');
// `git config --list -z --show-scope`: "scope\0key\nvalue\0" (or "scope\0key\0" for a bare key).
function parseConfig(out: string): { scope: string; key: string; value: string }[] {
  const parts = out.split('\0');
  const entries = [];
  for (let i = 0; i < parts.length; i++) {
    const scope = parts[i++];
    const rec = parts[i];
    if (!rec) continue;
    const nl = rec.indexOf('\n');
    entries.push({ scope, key: nl === -1 ? rec : rec.slice(0, nl), value: nl === -1 ? '' : rec.slice(nl + 1) });
  }
  return entries;
}
// The hooks git would run from `dir`: every file not ending in .sample (git for Windows runs them without an executable
// bit; elsewhere git skips a hook that isn't executable).
function hooksIn(dir: string, where: string, platform: string): RiskItem[] {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const items: RiskItem[] = [];
  for (const name of names.sort()) {
    if (name.endsWith('.sample')) continue;
    const file = path.join(dir, name);
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || (platform !== 'win32' && !(st.mode & 0o111))) continue;
      items.push({ kind: 'hook', where, name, detail: sha256(fs.readFileSync(file)) });
    } catch { /* gone or unreadable: git can't run it either */ }
  }
  return items;
}
const stderrOf = (e: unknown) => String((e as { stderr?: string })?.stderr || (e as Error)?.message || e);
// Past these a look gives up and the repository counts as unreadable: nothing runs. Never a silent stop.
const MAX_NESTED = 1000, MAX_DEPTH = 32;
interface Walk { platform: string; seen: Set<string>; found: RepoRisk[]; base: string }
// Where the folder's repository keeps its settings and hooks, and which of them run programs. null: not a repository.
// nested: also look into every nested repository (gitlinks with a .git of their own), for a call that may run something.
async function inspectRepo(exec: GitExec, cwd: string, { nested = false, platform = process.platform }: { nested?: boolean; platform?: string } = {}): Promise<RepoRisk | null> {
  const walk: Walk = { platform, seen: new Set(), found: [], base: '' };
  const risk = await inspectOne(exec, cwd, walk);
  if (!risk || !nested || risk.unreadable) return risk;
  try {
    await nestedIn(exec, risk, walk, 0);
  } catch (e) {
    return { ...risk, nested: walk.found, unreadable: `couldn't look into a nested repository: ${(e as Error).message}` };
  }
  return { ...risk, nested: walk.found };
}
const keyOf = (p: string, platform: string) => (platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
async function inspectOne(exec: GitExec, cwd: string, walk: Walk): Promise<(RepoRisk & { top: string }) | null> {
  const { platform } = walk;
  let gitDirs: string[];
  try {
    gitDirs = (await exec(cwd, ['rev-parse', '--absolute-git-dir', '--git-common-dir'])).split(/\r?\n/).filter(Boolean);
  } catch (e) {
    const why = stderrOf(e);
    if (/not a git repository/i.test(why)) return null;
    return { ...unreadable(keyOf(cwd, platform), why), top: '' };
  }
  const commonDir = path.resolve(cwd, gitDirs[1] || gitDirs[0]);
  const repo = keyOf(commonDir, platform);
  walk.seen.add(repo);
  const top = await exec(cwd, ['rev-parse', '--show-toplevel']).then(s => s.trim(), () => ''); // none in a bare repository
  const items: RiskItem[] = [];
  let config: { scope: string; key: string; value: string }[];
  try { config = parseConfig(await exec(cwd, ['config', '--list', '--show-scope', '-z'])); } catch (e) { return { ...unreadable(repo, stderrOf(e)), top }; }
  const hookDirs = [{ dir: path.join(commonDir, 'hooks'), where: 'hooks' }];
  for (const { scope, key, value } of config) {
    if (scope !== 'local' && scope !== 'worktree') continue; // the user's own global and system settings are theirs
    if (!riskyKey(key, value)) continue;
    items.push({ kind: 'config', where: scope === 'worktree' ? 'config.worktree' : 'config', name: key, detail: value });
    if (key.toLowerCase() === 'core.hookspath' && value) {
      const p = value.replace(/^~(?=$|[\\/])/, os.homedir());
      hookDirs.push({ dir: path.resolve(top || cwd, p), where: value });
    }
  }
  const seenDirs = new Set<string>();
  for (const { dir, where } of hookDirs) {
    const key = keyOf(dir, platform);
    if (seenDirs.has(key)) continue;
    seenDirs.add(key);
    items.push(...hooksIn(dir, where, platform));
  }
  return { ...finish(repo, items), top };
}
// The gitlinks in `parent`'s index whose folder has a .git (a directory, or a file pointing elsewhere), and theirs in
// turn. Each is looked at as a repository of its own and added to walk.found.
async function nestedIn(exec: GitExec, parent: RepoRisk & { top?: string }, walk: Walk, depth: number): Promise<void> {
  const top = parent.top;
  if (!top) return; // a bare repository has no work tree to hold one
  if (!walk.base) walk.base = top;
  if (depth >= MAX_DEPTH) throw new Error('nested too deep');
  const out = await exec(top, ['ls-files', '--stage', '-z', '--full-name']);
  const links = new Set<string>();
  for (const rec of out.split('\0')) if (rec.startsWith('160000 ')) links.add(rec.slice(rec.indexOf('\t') + 1));
  for (const rel of links) {
    const dir = path.join(top, rel);
    if (!fs.existsSync(path.join(dir, '.git'))) continue; // not checked out: git has nothing to go into
    if (walk.found.length >= MAX_NESTED) throw new Error('too many nested repositories');
    const risk = await inspectOne(exec, dir, walk).catch(e => ({ ...unreadable(keyOf(dir, walk.platform), stderrOf(e)), top: '' }));
    if (!risk) continue; // git can't open it as a repository, so it can't run anything there either
    // A broken .git makes discovery climb to a repository already seen (git itself refuses to go in): nothing new there.
    if (!risk.unreadable && risk.top && keyOf(risk.top, walk.platform) !== keyOf(dir, walk.platform)) continue;
    const where = path.relative(walk.base, dir).split(path.sep).join('/');
    // Kept under its git folder and its own folder: a .git file can point a nested one at a git folder already seen.
    const repo = `${risk.repo}|${keyOf(dir, walk.platform)}`;
    walk.found.push({ ...risk, repo, path: where, items: risk.items.map(i => ({ ...i, where: `${where}: ${i.where}` })) });
    if (!risk.unreadable) await nestedIn(exec, risk, walk, depth + 1);
  }
}
function finish(repo: string, items: RiskItem[], why?: string): RepoRisk {
  const drivers = { filter: new Set<string>(), diff: new Set<string>(), merge: new Set<string>(), hook: new Set<string>() };
  for (const i of items) {
    if (i.kind !== 'config') continue;
    const m = /^(filter|diff|merge|hook)\.(.+)\.(?:clean|smudge|process|command|textconv|driver)$/is.exec(i.name);
    if (m) drivers[m[1].toLowerCase() as 'filter' | 'diff' | 'merge' | 'hook'].add(m[2]);
  }
  const sorted = [...items].sort((a, b) => `${a.kind}\0${a.where}\0${a.name}\0${a.detail}`.localeCompare(`${b.kind}\0${b.where}\0${b.name}\0${b.detail}`));
  return {
    repo, items: sorted, fingerprint: sha256(JSON.stringify(sorted)),
    drivers: { filter: [...drivers.filter], diff: [...drivers.diff], merge: [...drivers.merge], hook: [...drivers.hook] },
    ...(why ? { unreadable: why.trim().slice(0, 500) } : {}),
  };
}
const unreadable = (repo: string, why: string) => finish(repo, [], why || 'unknown error');

/* ----- Trust ----- */
// The repository itself (deep false), or it and every nested repository looked at.
function isTrusted(risk: RepoRisk | null, store: Record<string, string> | undefined, deep = true): boolean {
  if (!risk) return true;
  const own = !risk.unreadable && (!risk.items.length || store?.[risk.repo] === risk.fingerprint);
  return own && (!deep || (risk.nested ?? []).every(r => isTrusted(r, store, false)));
}
// What a Trust answer stores: [repository, fingerprint] for it and each nested repository.
function trustEntries(risk: RepoRisk): [string, string][] {
  return [risk, ...(risk.nested ?? [])].filter(r => !r.unreadable).map(r => [r.repo, r.fingerprint]);
}

/* ----- Running git ----- */
// What switches the repository's programs off for one call: hooks from an empty folder and every hook event off
// (config-defined hooks too), named filters and diff drivers emptied (an empty command is skipped).
function neutralArgs(risk: RepoRisk, hooksDir: string): string[] {
  const pairs = [`core.hooksPath=${hooksDir}`, ...HOOK_EVENTS.map(e => `hook.${e}.enabled=false`)];
  for (const n of risk.drivers.hook) pairs.push(`hook.${n}.enabled=false`);
  for (const n of risk.drivers.filter) pairs.push(`filter.${n}.clean=`, `filter.${n}.smudge=`, `filter.${n}.process=`, `filter.${n}.required=false`);
  for (const n of risk.drivers.diff) pairs.push(`diff.${n}.textconv=`, `diff.${n}.command=`);
  for (const n of risk.drivers.merge) pairs.push(`merge.${n}.driver=`);
  pairs.push('diff.external=');
  return pairs.flatMap(p => ['-c', p]);
}
// The arguments to run git with in a repository whose risks are `risk` (null: no repository), given the stored trust,
// or a GitTrustError. A read needs only the repository itself trusted (it never goes into nested ones); anything else
// needs it and every nested repository trusted, so `risk` must come from a look with `nested`.
function gateGitArgs(args: string[], { risk, store, hooksDir }: { risk: RepoRisk | null; store: Record<string, string> | undefined; hooksDir: string }): string[] {
  if (risk?.unreadable) throw new GitTrustError(`Breeze couldn't read this repository's git settings, so it won't run git here: ${risk.unreadable}`);
  const read = gitReadOnly(args);
  if (!risk || isTrusted(risk, store, !read)) return safeGitArgs(args);
  if (!read) {
    const bad = (risk.nested ?? []).find(r => r.unreadable);
    if (bad) throw new GitTrustError(`Breeze couldn't read the git settings of ${bad.path}, so it won't run git here: ${bad.unreadable}`);
    throw new GitTrustError(UNTRUSTED_MESSAGE);
  }
  if (!hooksDir) throw new GitTrustError('Refusing to run git without an empty hooks folder');
  // A name -c can't carry (git splits at the first "=") can't be switched off: nothing runs.
  const d = risk.drivers;
  if ([...d.filter, ...d.diff, ...d.merge, ...d.hook].some(n => /[=\n]/.test(n))) throw new GitTrustError(UNTRUSTED_MESSAGE);
  return safeGitArgs([...neutralArgs(risk, hooksDir), ...args]);
}

export { riskyKey, gitReadOnly, inspectRepo, isTrusted, trustEntries, neutralArgs, gateGitArgs, GitTrustError, UNTRUSTED, UNTRUSTED_MESSAGE, HOOK_EVENTS };
