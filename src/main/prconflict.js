// Resolves a pull request's merge conflicts in a separate, throwaway git worktree, so the user's own
// checkout is never touched. Pure of electron: git runs through the injected
// run(cwd, args, input?) => Promise<stdout>, which rejects on a non-zero exit with the exit code on
// `.code` and the output on `.stdout` / `.stderr`.
//
// Inside the worktree HEAD is the pull request head and origin/<base> is merged into it, so "ours"
// (stage 2) is the PR side and "theirs" (stage 3) is the base side.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const hashOf = repoDir => crypto.createHash('sha1').update(path.resolve(repoDir)).digest('hex').slice(0, 8);
const refOf = number => `refs/breeze/pr-${number}`;
const swallow = () => {};
const BINARY_CHOICES = ['ours', 'theirs', 'delete'];

// The worktree holds the pull request's files, which anyone who can open a pull request wrote. Git would run
// hooks from there (a relative core.hooksPath resolves inside the worktree, and hook managers read their
// config from it), on checkout, commit and push. Every call made here points core.hooksPath at an empty
// folder the caller owns, and nothing runs without one.
function hooksOff(run, hooksDir) {
  if (typeof hooksDir !== 'string' || !hooksDir) throw new Error('Refusing to run git without an empty hooks folder (hooksDir)');
  return (cwd, args, input) => run(cwd, ['-c', `core.hooksPath=${hooksDir}`, ...args], input);
}

// Marks which part of finishing failed, so the caller can tell "nothing was committed" from "only the push is left".
function tagged(e, stage) {
  const err = e instanceof Error ? e : new Error(String(e));
  err.stage = stage;
  return err;
}

// A file can be shown and merged as text only when every version of it is UTF-8 without NUL bytes: anything
// else would be changed by decoding it and writing it back.
const isText = buf => !buf.includes(0) && Buffer.from(buf.toString('utf8'), 'utf8').equals(buf);

// The unmerged index entries: path -> { 1|2|3: { mode, sha } }.
async function unmergedStages(git, dir) {
  const out = await git(dir, ['ls-files', '-u', '-z']);
  const map = new Map();
  for (const rec of out.split('\0')) {
    const m = /^(\d+) ([0-9a-f]+) ([123])\t(.+)$/s.exec(rec);
    if (!m) continue;
    if (!map.has(m[4])) map.set(m[4], {});
    map.get(m[4])[m[3]] = { mode: m[1], sha: m[2] };
  }
  return map;
}

// The raw bytes of each side of a conflicted file, written by git to temporary files (git's own output is read
// as text, which would hide bytes that aren't UTF-8). null for a side that has no version.
async function rawSides(git, dir, p) {
  const out = await git(dir, ['checkout-index', '--stage=all', '--temp', '--', p]);
  const names = out.split('\n')[0].split('\t')[0].split(' ');
  const read = name => {
    if (!name || name === '.') return null;
    const abs = path.join(dir, name);
    try { return fs.readFileSync(abs); } finally { try { fs.unlinkSync(abs); } catch {} }
  };
  const [, ours, theirs] = names.map(read);
  return { ours: ours ?? null, theirs: theirs ?? null };
}

// Takes the worktree out of git's books and off the disk, then drops the PR ref. Best effort: this
// runs on the way out of failures too, so nothing in it may throw.
async function removeWorktree(git, repoDir, dir, number) {
  try {
    await git(repoDir, ['worktree', 'remove', '--force', dir]);
  } catch {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    await git(repoDir, ['worktree', 'prune']).catch(swallow);
  }
  await git(repoDir, ['update-ref', '-d', refOf(number)]).catch(swallow);
}

// Each conflicted file is { path, kind, ours, theirs, merged, hasOurs, hasTheirs }. kind 'text': ours / theirs
// are the two sides (null: that side deleted it) and merged is the file with conflict markers. kind 'binary': a
// file that isn't UTF-8 text, which is never decoded; ours / theirs / merged are null and hasOurs / hasTheirs
// say which sides have a version. It is resolved by keeping one side or deleting it.
async function startConflict({ run, hooksDir, repoDir, worktreesDir, number, base, headRef }) {
  const git = hooksOff(run, hooksDir);
  const id = `${hashOf(repoDir)}-${number}`;
  const dir = path.join(worktreesDir, id);
  const ref = refOf(number);
  const session = { id, dir, number, base, headRef, clean: false, files: [], repoDir, stages: {} };
  try {
    await git(repoDir, ['fetch', 'origin', `+pull/${number}/head:${ref}`]);
    await git(repoDir, ['fetch', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`]);
    if (fs.existsSync(dir)) {
      // A leftover from an earlier session of this same pull request.
      await git(repoDir, ['worktree', 'remove', '--force', dir]).catch(swallow);
      fs.rmSync(dir, { recursive: true, force: true });
      await git(repoDir, ['worktree', 'prune']).catch(swallow);
    }
    fs.mkdirSync(worktreesDir, { recursive: true });
    await git(repoDir, ['worktree', 'add', '--detach', dir, ref]);
    try {
      await git(dir, ['merge', '--no-commit', '--no-ff', `origin/${base}`]);
    } catch (e) {
      // Exit 1 means "conflicts", but only when a merge is actually in progress; exit 1 also covers
      // "not something we can merge", and anything else is a real failure.
      if (!e || e.code !== 1 || !(await git(dir, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).then(() => true, () => false))) throw e;
    }
    const paths = (await git(dir, ['diff', '--name-only', '-z', '--diff-filter=U'])).split('\0').filter(Boolean);
    const stages = paths.length ? await unmergedStages(git, dir) : new Map();
    for (const p of paths) {
      const st = stages.get(p) || {};
      session.stages[p] = { ours: st[2] ?? null, theirs: st[3] ?? null };
      const raw = await rawSides(git, dir, p);
      let work = null;
      try { work = fs.readFileSync(path.join(dir, p)); } catch { /* modify/delete: git leaves no file */ }
      if (![raw.ours, raw.theirs, work].every(b => b === null || isText(b))) {
        session.files.push({ path: p, kind: 'binary', ours: null, theirs: null, merged: null, hasOurs: raw.ours !== null, hasTheirs: raw.theirs !== null });
        continue;
      }
      const ours = await git(dir, ['show', `:2:${p}`]).catch(() => null);
      const theirs = await git(dir, ['show', `:3:${p}`]).catch(() => null);
      const merged = work !== null ? work.toString('utf8') : ours ?? theirs ?? ''; // modify/delete: show the side that survived
      session.files.push({ path: p, kind: 'text', ours, theirs, merged, hasOurs: ours !== null, hasTheirs: theirs !== null });
    }
    session.clean = session.files.length === 0;
    return session;
  } catch (e) {
    await removeWorktree(git, repoDir, dir, number);
    throw e;
  }
}

// results: { path, text } for a text file (text null deletes it), { path, choice: 'ours' | 'theirs' | 'delete' }
// for a binary one. A failure carries its stage on `.stage`: 'commit' (writing, staging or committing; nothing
// was committed, so the resolution can still change) or 'push' (the resolution is committed in the worktree and
// a retry only pushes).
async function finishConflict({ run, hooksDir, session, results, pushTo = 'origin' }) {
  const git = hooksOff(run, hooksDir);
  const { dir, number, headRef, base, repoDir } = session;
  const message = `Merge ${base} into ${headRef} (resolved in Breeze)`;
  const root = path.resolve(dir);
  const kinds = new Map((session.files || []).map(f => [f.path, f.kind]));
  try {
    const resolved = results.map(r => {
      const abs = path.resolve(root, r.path);
      if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`Path is outside the conflict worktree: ${r.path}`);
      const binary = kinds.get(r.path) === 'binary';
      if (binary && !BINARY_CHOICES.includes(r.choice)) throw new Error(`${r.path} can only be kept from one side or deleted`);
      if (!binary && !(r.text === null || typeof r.text === 'string')) throw new Error(`No resolution for ${r.path}`);
      return { ...r, abs, binary };
    });
    // A retry after a failed push: the resolution is already committed (the merge is over and HEAD is
    // our commit), so there is nothing left to write or commit.
    const inMerge = await git(dir, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).then(() => true, () => false);
    const committed = !inMerge && (await git(dir, ['log', '-1', '--format=%s']).catch(() => '')).trim() === message;
    if (!committed) {
      for (const r of resolved) {
        if (r.binary) {
          // The chosen side's blob goes into the index as it is, never through a decode. This also works on a
          // retry, when an earlier attempt already staged the file and the conflict stages are gone.
          const blob = r.choice === 'delete' ? null : session.stages?.[r.path]?.[r.choice] ?? null;
          if (blob === null) {
            await git(dir, ['rm', '--force', '--quiet', '--ignore-unmatch', '--', r.path]);
          } else {
            await git(dir, ['update-index', '--add', '--cacheinfo', blob.mode, blob.sha, r.path]);
            await git(dir, ['checkout-index', '--force', '--', r.path]);
          }
        } else if (r.text === null) {
          await git(dir, ['rm', '--force', '--quiet', '--ignore-unmatch', '--', r.path]);
        } else {
          fs.mkdirSync(path.dirname(r.abs), { recursive: true });
          fs.writeFileSync(r.abs, r.text);
          await git(dir, ['add', '--', r.path]);
        }
      }
      await git(dir, ['commit', '--no-verify', '-m', message]);
    }
  } catch (e) {
    throw tagged(e, 'commit');
  }
  // pushTo is a remote name or a URL, for a pull request whose branch lives in a fork.
  try {
    await git(dir, ['push', '--no-verify', pushTo, `HEAD:refs/heads/${headRef}`]);
  } catch (e) {
    throw tagged(e, 'push');
  }
  await removeWorktree(git, repoDir, dir, number);
}

async function abortConflict({ run, hooksDir, repoDir, session }) {
  const git = hooksOff(run, hooksDir);
  await git(session.dir, ['merge', '--abort']).catch(swallow);
  await removeWorktree(git, repoDir, session.dir, session.number);
}

async function pruneConflicts({ run, hooksDir, repoDir, worktreesDir }) {
  const git = hooksOff(run, hooksDir);
  await git(repoDir, ['worktree', 'prune']).catch(swallow);
  const prefix = hashOf(repoDir) + '-';
  let names = [];
  try { names = fs.readdirSync(worktreesDir); } catch { return; }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    try { fs.rmSync(path.join(worktreesDir, name), { recursive: true, force: true }); } catch {} // one locked folder must not stop the rest
  }
  // Those folders may still have been registered with git; now they are gone, drop the registrations.
  await git(repoDir, ['worktree', 'prune']).catch(swallow);
}

module.exports = { startConflict, finishConflict, abortConflict, pruneConflicts };
