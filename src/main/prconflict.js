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

// Takes the worktree out of git's books and off the disk, then drops the PR ref. Best effort: this
// runs on the way out of failures too, so nothing in it may throw.
async function removeWorktree(run, repoDir, dir, number) {
  try {
    await run(repoDir, ['worktree', 'remove', '--force', dir]);
  } catch {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    await run(repoDir, ['worktree', 'prune']).catch(swallow);
  }
  await run(repoDir, ['update-ref', '-d', refOf(number)]).catch(swallow);
}

async function startConflict({ run, repoDir, worktreesDir, number, base, headRef }) {
  const id = `${hashOf(repoDir)}-${number}`;
  const dir = path.join(worktreesDir, id);
  const ref = refOf(number);
  const session = { id, dir, number, base, headRef, clean: false, files: [], repoDir };
  try {
    await run(repoDir, ['fetch', 'origin', `+pull/${number}/head:${ref}`]);
    await run(repoDir, ['fetch', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`]);
    if (fs.existsSync(dir)) {
      // A leftover from an earlier session of this same pull request.
      await run(repoDir, ['worktree', 'remove', '--force', dir]).catch(swallow);
      fs.rmSync(dir, { recursive: true, force: true });
      await run(repoDir, ['worktree', 'prune']).catch(swallow);
    }
    fs.mkdirSync(worktreesDir, { recursive: true });
    await run(repoDir, ['worktree', 'add', '--detach', dir, ref]);
    try {
      await run(dir, ['merge', '--no-commit', '--no-ff', `origin/${base}`]);
    } catch (e) {
      if (e && e.code !== 1) throw e; // exit 1 is "conflicts", anything else is a real failure
    }
    const paths = (await run(dir, ['diff', '--name-only', '-z', '--diff-filter=U'])).split('\0').filter(Boolean);
    for (const p of paths) {
      const ours = await run(dir, ['show', `:2:${p}`]).catch(() => null);
      const theirs = await run(dir, ['show', `:3:${p}`]).catch(() => null);
      let merged;
      try {
        merged = fs.readFileSync(path.join(dir, p), 'utf8');
      } catch {
        merged = ours ?? theirs ?? ''; // modify/delete: git leaves no file, so show the side that survived
      }
      session.files.push({ path: p, ours, theirs, merged });
    }
    session.clean = session.files.length === 0;
    return session;
  } catch (e) {
    await removeWorktree(run, repoDir, dir, number);
    throw e;
  }
}

async function finishConflict({ run, session, results }) {
  const { dir, number, headRef, base, repoDir } = session;
  const root = path.resolve(dir);
  const resolved = results.map(r => {
    const abs = path.resolve(root, r.path);
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`Path is outside the conflict worktree: ${r.path}`);
    return { ...r, abs };
  });
  for (const r of resolved) {
    if (r.text === null) {
      await run(dir, ['rm', '--force', '--quiet', '--', r.path]);
    } else {
      fs.mkdirSync(path.dirname(r.abs), { recursive: true });
      fs.writeFileSync(r.abs, r.text);
      await run(dir, ['add', '--', r.path]);
    }
  }
  await run(dir, ['commit', '-m', `Merge ${base} into ${headRef} (resolved in Breeze)`]);
  await run(dir, ['push', 'origin', `HEAD:refs/heads/${headRef}`]);
  await removeWorktree(run, repoDir, dir, number);
}

async function abortConflict({ run, repoDir, session }) {
  await run(session.dir, ['merge', '--abort']).catch(swallow);
  await removeWorktree(run, repoDir, session.dir, session.number);
}

async function pruneConflicts({ run, repoDir, worktreesDir }) {
  await run(repoDir, ['worktree', 'prune']).catch(swallow);
  const prefix = hashOf(repoDir) + '-';
  let names = [];
  try { names = fs.readdirSync(worktreesDir); } catch { return; }
  for (const name of names) {
    if (name.startsWith(prefix)) fs.rmSync(path.join(worktreesDir, name), { recursive: true, force: true });
  }
  // Those folders may still have been registered with git; now they are gone, drop the registrations.
  await run(repoDir, ['worktree', 'prune']).catch(swallow);
}

module.exports = { startConflict, finishConflict, abortConflict, pruneConflicts };
