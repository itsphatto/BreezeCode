const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { startConflict, finishConflict, abortConflict, pruneConflicts } = require('../src/main/prconflict');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'breeze-prc-'));
test.after(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

// Real git. Rejects with the exit code and output attached, like the app's runner does.
const run = (cwd, args, input) => new Promise((resolve, reject) => {
  const child = execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); } else resolve(stdout);
  });
  if (input != null) child.stdin.end(input); else child.stdin.end();
});

let counter = 0;
// Builds a bare origin and a clone of it. `base` is the first commit on main, `feature` is the PR
// branch (pushed to refs/pull/<n>/head like GitHub does), `main` is what main moves on to after.
// A null value deletes the file on that side.
async function scenario({ base, feature, main, prs = { 7: 'feature' }, config = {} }) {
  const root = path.join(tmpRoot, 's' + (++counter));
  const origin = path.join(root, 'origin.git');
  const repoDir = path.join(root, 'repo');
  const worktreesDir = path.join(root, 'worktrees');
  const hooksDir = path.join(root, 'no-hooks'); // the empty folder the app passes as core.hooksPath
  fs.mkdirSync(origin, { recursive: true });
  fs.mkdirSync(hooksDir, { recursive: true });
  await run(origin, ['init', '--bare']);
  await run(origin, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  await run(root, ['clone', origin, repoDir]);
  await run(repoDir, ['config', 'user.name', 'Test']);
  await run(repoDir, ['config', 'user.email', 'test@example.com']);
  await run(repoDir, ['config', 'core.autocrlf', 'false']);
  await run(repoDir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  for (const [k, v] of Object.entries(config)) await run(repoDir, ['config', k, v]);
  const apply = async (files, message) => {
    for (const [name, text] of Object.entries(files)) {
      if (text === null) await run(repoDir, ['rm', '-q', '--', name]);
      else {
        fs.mkdirSync(path.dirname(path.join(repoDir, name)), { recursive: true });
        fs.writeFileSync(path.join(repoDir, name), text, { mode: name.startsWith('hooks/') ? 0o755 : 0o644 });
        await run(repoDir, ['add', '--', name]);
      }
    }
    await run(repoDir, ['commit', '-q', '-m', message]);
  };
  await apply(base, 'base');
  await run(repoDir, ['push', 'origin', 'main']);
  for (const [n, branch] of Object.entries(prs)) {
    await run(repoDir, ['checkout', '-q', '-b', branch, 'main']);
    await apply(branch === 'feature' ? feature : { 'd.txt': 'added\n' }, 'change on ' + branch);
    await run(repoDir, ['push', 'origin', `${branch}:refs/heads/${branch}`, `${branch}:refs/pull/${n}/head`]);
    await run(repoDir, ['checkout', '-q', 'main']);
  }
  await apply(main, 'change on main');
  await run(repoDir, ['push', 'origin', 'main']);
  return { origin, repoDir, worktreesDir, hooksDir };
}

// The command in a call prconflict made, past the -c pairs it puts first.
const cmdOf = args => { let i = 0; while (args[i] === '-c') i += 2; return args[i]; };

const textScenario = () => scenario({
  base: { 'a.txt': 'one\n', 'b.txt': 'base\n' },
  feature: { 'a.txt': 'feature\n', 'b.txt': 'feature\n' },
  main: { 'a.txt': 'main\n', 'b.txt': null },
});

const worktreeCount = async repoDir =>
  (await run(repoDir, ['worktree', 'list', '--porcelain'])).split('\n').filter(l => l.startsWith('worktree ')).length;
const refExists = (repoDir, ref) => run(repoDir, ['rev-parse', '--verify', '--quiet', ref]).then(() => true, () => false);

test('startConflict lists conflicted files with both sides and the merged text', async () => {
  const { repoDir, worktreesDir, hooksDir } = await textScenario();
  const session = await startConflict({ run, hooksDir, repoDir, worktreesDir, number: 7, base: 'main', headRef: 'feature' });
  assert.equal(session.clean, false);
  assert.equal(session.number, 7);
  assert.equal(session.base, 'main');
  assert.equal(session.headRef, 'feature');
  assert.equal(session.id, crypto.createHash('sha1').update(path.resolve(repoDir)).digest('hex').slice(0, 8) + '-7');
  assert.equal(session.dir, path.join(worktreesDir, session.id));
  assert.equal(session.files.length, 2);
  const a = session.files.find(f => f.path === 'a.txt');
  assert.equal(a.ours, 'feature\n');
  assert.equal(a.theirs, 'main\n');
  assert.ok(a.merged.includes('<<<<<<<'));
  const b = session.files.find(f => f.path === 'b.txt');
  assert.equal(b.ours, 'feature\n');
  assert.equal(b.theirs, null);
  assert.equal(typeof b.merged, 'string');
  await abortConflict({ run, hooksDir, repoDir, session });
});

test("startConflict leaves the user's own checkout untouched", async () => {
  const { repoDir, worktreesDir, hooksDir } = await textScenario();
  const headBefore = (await run(repoDir, ['rev-parse', 'HEAD'])).trim();
  const session = await startConflict({ run, hooksDir, repoDir, worktreesDir, number: 7, base: 'main', headRef: 'feature' });
  assert.equal((await run(repoDir, ['status', '--porcelain'])).trim(), '');
  assert.equal((await run(repoDir, ['rev-parse', 'HEAD'])).trim(), headBefore);
  assert.equal((await run(repoDir, ['symbolic-ref', 'HEAD'])).trim(), 'refs/heads/main');
  await abortConflict({ run, hooksDir, repoDir, session });
});

test('startConflict reports clean when nothing conflicts', async () => {
  const { repoDir, worktreesDir, hooksDir } = await scenario({
    base: { 'a.txt': 'one\n' },
    feature: {},
    main: { 'a.txt': 'main\n' },
    prs: { 8: 'tidy' },
  });
  const session = await startConflict({ run, hooksDir, repoDir, worktreesDir, number: 8, base: 'main', headRef: 'tidy' });
  assert.equal(session.clean, true);
  assert.deepEqual(session.files, []);
  await abortConflict({ run, hooksDir, repoDir, session });
});

test('startConflict keeps CRLF line endings in merged', async () => {
  const { repoDir, worktreesDir, hooksDir } = await scenario({
    base: { 'c.txt': 'x\r\none\r\n' },
    feature: { 'c.txt': 'x\r\nfeature\r\n' },
    main: { 'c.txt': 'x\r\nmain\r\n' },
  });
  const session = await startConflict({ run, hooksDir, repoDir, worktreesDir, number: 7, base: 'main', headRef: 'feature' });
  assert.equal(session.files.length, 1);
  const c = session.files[0];
  assert.equal(c.ours, 'x\r\nfeature\r\n');
  assert.equal(c.theirs, 'x\r\nmain\r\n');
  assert.ok(c.merged.includes('feature\r\n'));
  assert.ok(c.merged.includes('main\r\n'));
  assert.ok(c.merged.includes('<<<<<<<'));
  await abortConflict({ run, hooksDir, repoDir, session });
});

test('startConflict replaces a leftover worktree for the same pull request', async () => {
  const { repoDir, worktreesDir, hooksDir } = await textScenario();
  const first = await startConflict({ run, hooksDir, repoDir, worktreesDir, number: 7, base: 'main', headRef: 'feature' });
  const second = await startConflict({ run, hooksDir, repoDir, worktreesDir, number: 7, base: 'main', headRef: 'feature' });
  assert.equal(second.dir, first.dir);
  assert.equal(second.files.length, 2);
  assert.equal(await worktreeCount(repoDir), 2);
  await abortConflict({ run, hooksDir, repoDir, session: second });
});

test('startConflict cleans up and rethrows when the pull request cannot be fetched', async () => {
  const { repoDir, worktreesDir, hooksDir } = await textScenario();
  await assert.rejects(startConflict({ run, hooksDir, repoDir, worktreesDir, number: 99, base: 'main', headRef: 'feature' }));
  assert.equal(await worktreeCount(repoDir), 1);
  assert.equal(await refExists(repoDir, 'refs/breeze/pr-99'), false);
});

test('finishConflict commits the resolution, pushes it and removes the worktree and ref', async () => {
  const { origin, repoDir, worktreesDir, hooksDir } = await textScenario();
  const session = await startConflict({ run, hooksDir, repoDir, worktreesDir, number: 7, base: 'main', headRef: 'feature' });
  await finishConflict({ run, hooksDir, session, results: [{ path: 'a.txt', text: 'both\n' }, { path: 'b.txt', text: null }] });
  assert.equal((await run(origin, ['log', '-1', '--format=%s', 'refs/heads/feature'])).trim(), 'Merge main into feature (resolved in Breeze)');
  assert.equal(await run(origin, ['show', 'refs/heads/feature:a.txt']), 'both\n');
  assert.equal((await run(origin, ['ls-tree', '--name-only', 'refs/heads/feature'])).split('\n').includes('b.txt'), false);
  // It is a real merge: the tip of main is a parent.
  const parents = (await run(origin, ['log', '-1', '--format=%P', 'refs/heads/feature'])).trim().split(' ');
  assert.equal(parents.length, 2);
  assert.ok(parents.includes((await run(origin, ['rev-parse', 'refs/heads/main'])).trim()));
  assert.equal(fs.existsSync(session.dir), false);
  assert.equal(await worktreeCount(repoDir), 1);
  assert.equal(await refExists(repoDir, 'refs/breeze/pr-7'), false);
});

test('finishConflict writes text exactly as given, CRLF included', async () => {
  const { origin, repoDir, worktreesDir, hooksDir } = await scenario({
    base: { 'c.txt': 'x\r\none\r\n' },
    feature: { 'c.txt': 'x\r\nfeature\r\n' },
    main: { 'c.txt': 'x\r\nmain\r\n' },
  });
  const session = await startConflict({ run, hooksDir, repoDir, worktreesDir, number: 7, base: 'main', headRef: 'feature' });
  await finishConflict({ run, hooksDir, session, results: [{ path: 'c.txt', text: 'x\r\nboth\r\n' }] });
  assert.equal(await run(origin, ['show', 'refs/heads/feature:c.txt']), 'x\r\nboth\r\n');
});

test('finishConflict keeps the worktree and ref when the push fails', async () => {
  const { repoDir, worktreesDir, hooksDir } = await textScenario();
  const session = await startConflict({ run, hooksDir, repoDir, worktreesDir, number: 7, base: 'main', headRef: 'feature' });
  const failingPush = (cwd, args, input) =>
    cmdOf(args) === 'push' ? Promise.reject(new Error('push rejected')) : run(cwd, args, input);
  await assert.rejects(
    finishConflict({ run: failingPush, hooksDir, session, results: [{ path: 'a.txt', text: 'both\n' }, { path: 'b.txt', text: null }] }),
    /push rejected/,
  );
  assert.equal(fs.existsSync(session.dir), true);
  assert.equal(await refExists(repoDir, 'refs/breeze/pr-7'), true);
  await abortConflict({ run, hooksDir, repoDir, session });
});

test('finishConflict refuses a path outside the worktree', async () => {
  const { repoDir, worktreesDir, hooksDir } = await textScenario();
  const session = await startConflict({ run, hooksDir, repoDir, worktreesDir, number: 7, base: 'main', headRef: 'feature' });
  await assert.rejects(finishConflict({ run, hooksDir, session, results: [{ path: '../escape.txt', text: 'x' }] }), /outside/);
  assert.equal(fs.existsSync(path.join(worktreesDir, 'escape.txt')), false);
  await abortConflict({ run, hooksDir, repoDir, session });
});

test('abortConflict leaves no worktree and no ref behind', async () => {
  const { repoDir, worktreesDir, hooksDir } = await textScenario();
  const session = await startConflict({ run, hooksDir, repoDir, worktreesDir, number: 7, base: 'main', headRef: 'feature' });
  assert.equal(await worktreeCount(repoDir), 2);
  assert.equal(await refExists(repoDir, 'refs/breeze/pr-7'), true);
  await abortConflict({ run, hooksDir, repoDir, session });
  assert.equal(await worktreeCount(repoDir), 1);
  assert.equal(await refExists(repoDir, 'refs/breeze/pr-7'), false);
  assert.equal(fs.existsSync(session.dir), false);
  // Aborting twice is harmless.
  await abortConflict({ run, hooksDir, repoDir, session });
});

test("pruneConflicts removes this repo's leftover folders and no others", async () => {
  const { repoDir, worktreesDir, hooksDir } = await textScenario();
  const hash = crypto.createHash('sha1').update(path.resolve(repoDir)).digest('hex').slice(0, 8);
  const mine = path.join(worktreesDir, hash + '-3');
  const theirs = path.join(worktreesDir, 'deadbeef-3');
  fs.mkdirSync(mine, { recursive: true });
  fs.writeFileSync(path.join(mine, 'x.txt'), 'x');
  fs.mkdirSync(theirs, { recursive: true });
  await pruneConflicts({ run, hooksDir, repoDir, worktreesDir });
  assert.equal(fs.existsSync(mine), false);
  assert.equal(fs.existsSync(theirs), true);
});

test('pruneConflicts drops the registration of a worktree whose folder was deleted', async () => {
  const { repoDir, worktreesDir, hooksDir } = await textScenario();
  const session = await startConflict({ run, hooksDir, repoDir, worktreesDir, number: 7, base: 'main', headRef: 'feature' });
  assert.equal(await worktreeCount(repoDir), 2);
  await pruneConflicts({ run, hooksDir, repoDir, worktreesDir });
  assert.equal(fs.existsSync(session.dir), false);
  assert.equal(await worktreeCount(repoDir), 1);
});

test('pruneConflicts is fine when the worktrees folder does not exist', async () => {
  const { repoDir, worktreesDir, hooksDir } = await textScenario();
  await pruneConflicts({ run, hooksDir, repoDir, worktreesDir });
});

const bareRepo = async name => {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  await run(dir, ['init', '--bare']);
  return dir;
};
const resolveBoth = [{ path: 'a.txt', text: 'both\n' }, { path: 'b.txt', text: null }];

test('finishConflict pushes to pushTo (a fork) and not to origin', async () => {
  const { origin, repoDir, worktreesDir, hooksDir } = await textScenario();
  const fork = await bareRepo('fork.git');
  const originTip = (await run(origin, ['rev-parse', 'refs/heads/feature'])).trim();
  const session = await startConflict({ run, hooksDir, repoDir, worktreesDir, number: 7, base: 'main', headRef: 'feature' });
  await finishConflict({ run, hooksDir, session, results: resolveBoth, pushTo: fork });
  assert.equal((await run(fork, ['log', '-1', '--format=%s', 'refs/heads/feature'])).trim(), 'Merge main into feature (resolved in Breeze)');
  assert.equal(await run(fork, ['show', 'refs/heads/feature:a.txt']), 'both\n');
  assert.equal((await run(origin, ['rev-parse', 'refs/heads/feature'])).trim(), originTip);
  assert.equal(fs.existsSync(session.dir), false);
  assert.equal(await refExists(repoDir, 'refs/breeze/pr-7'), false);
});

test('finishConflict can be retried after a failed push and then pushes the same commit', async () => {
  const { origin, repoDir, worktreesDir, hooksDir } = await textScenario();
  const session = await startConflict({ run, hooksDir, repoDir, worktreesDir, number: 7, base: 'main', headRef: 'feature' });
  await assert.rejects(finishConflict({ run, hooksDir, session, results: resolveBoth, pushTo: path.join(tmpRoot, 'nowhere.git') }));
  assert.equal(fs.existsSync(session.dir), true);
  assert.equal(await refExists(repoDir, 'refs/breeze/pr-7'), true);
  const committed = (await run(session.dir, ['rev-parse', 'HEAD'])).trim();
  await finishConflict({ run, hooksDir, session, results: resolveBoth });
  assert.equal((await run(origin, ['rev-parse', 'refs/heads/feature'])).trim(), committed);
  assert.equal((await run(origin, ['log', '-1', '--format=%s', 'refs/heads/feature'])).trim(), 'Merge main into feature (resolved in Breeze)');
  assert.equal(fs.existsSync(session.dir), false);
  assert.equal(await refExists(repoDir, 'refs/breeze/pr-7'), false);
});

test('startConflict treats merge exit 1 without a merge in progress as a failure', async () => {
  const { repoDir, worktreesDir, hooksDir } = await textScenario();
  const badMerge = (cwd, args, input) =>
    cmdOf(args) === 'merge' ? Promise.reject(Object.assign(new Error('not something we can merge'), { code: 1 })) : run(cwd, args, input);
  await assert.rejects(
    startConflict({ run: badMerge, hooksDir, repoDir, worktreesDir, number: 7, base: 'main', headRef: 'feature' }),
    /not something we can merge/,
  );
  assert.equal(await worktreeCount(repoDir), 1);
  assert.equal(await refExists(repoDir, 'refs/breeze/pr-7'), false);
});

test('every call refuses to run without a hooks folder', async () => {
  const { repoDir, worktreesDir } = await textScenario();
  const calls = [];
  const spy = (cwd, args, input) => { calls.push(args); return run(cwd, args, input); };
  await assert.rejects(startConflict({ run: spy, repoDir, worktreesDir, number: 7, base: 'main', headRef: 'feature' }), /hooks/);
  await assert.rejects(pruneConflicts({ run: spy, repoDir, worktreesDir }), /hooks/);
  await assert.rejects(abortConflict({ run: spy, repoDir, session: { dir: worktreesDir, number: 7 } }), /hooks/);
  await assert.rejects(finishConflict({ run: spy, session: { dir: worktreesDir, number: 7, files: [] }, results: [] }), /hooks/);
  assert.deepEqual(calls, []);
});

test("no hook runs from start to finish, not the repository's nor one the pull request brings", async () => {
  const sentinels = path.join(tmpRoot, 'sentinels-' + (++counter));
  fs.mkdirSync(sentinels, { recursive: true });
  // Each hook leaves a file named after itself.
  const hook = `#!/bin/sh\ntouch "${sentinels.split(path.sep).join('/')}/$(basename "$0")"\nexit 0\n`;
  const names = ['post-checkout', 'pre-commit', 'commit-msg', 'post-commit', 'pre-push', 'post-merge', 'pre-merge-commit', 'reference-transaction', 'prepare-commit-msg'];
  const prHooks = Object.fromEntries(names.map(n => [`hooks/${n}`, hook]));
  // core.hooksPath is relative, so in the conflict worktree it would find the scripts the pull request committed.
  const { origin, repoDir, worktreesDir, hooksDir } = await scenario({
    base: { 'a.txt': 'one\n' },
    feature: { 'a.txt': 'feature\n', ...prHooks },
    main: { 'a.txt': 'main\n' },
    config: { 'core.hooksPath': 'hooks' },
  });
  // Building the scenario ran some of them (it commits and pushes on the branch that has them): start clean.
  for (const n of fs.readdirSync(sentinels)) fs.rmSync(path.join(sentinels, n));
  // And the repository's own hooks folder has them too.
  const own = path.join(repoDir, '.git', 'hooks');
  fs.mkdirSync(own, { recursive: true });
  for (const n of names) fs.writeFileSync(path.join(own, n), hook, { mode: 0o755 });

  const session = await startConflict({ run, hooksDir, repoDir, worktreesDir, number: 7, base: 'main', headRef: 'feature' });
  assert.equal(fs.existsSync(path.join(session.dir, 'hooks', 'post-checkout')), true); // the scripts are there to run
  await finishConflict({ run, hooksDir, session, results: [{ path: 'a.txt', text: 'both\n' }] });
  assert.equal(await run(origin, ['show', 'refs/heads/feature:a.txt']), 'both\n');
  assert.deepEqual(fs.readdirSync(sentinels), []);
  assert.deepEqual(fs.readdirSync(hooksDir), []);

  // Without the guard those hooks do run, so the check above means something.
  await run(repoDir, ['checkout', '-q', 'feature']);
  assert.equal(fs.existsSync(path.join(sentinels, 'post-checkout')), true);
});

test('a failure while committing carries stage commit, a failed push stage push', async () => {
  const { repoDir, worktreesDir, hooksDir } = await textScenario();
  const session = await startConflict({ run, hooksDir, repoDir, worktreesDir, number: 7, base: 'main', headRef: 'feature' });
  const failing = which => (cwd, args, input) =>
    cmdOf(args) === which ? Promise.reject(new Error(`${which} failed`)) : run(cwd, args, input);
  await assert.rejects(finishConflict({ run: failing('commit'), hooksDir, session, results: resolveBoth }), e => e.stage === 'commit' && /commit failed/.test(e.message));
  // Nothing was committed: the merge is still in progress.
  assert.equal(await refExists(session.dir, 'MERGE_HEAD'), true);
  await assert.rejects(finishConflict({ run: failing('push'), hooksDir, session, results: resolveBoth }), e => e.stage === 'push' && /push failed/.test(e.message));
  assert.equal(await refExists(session.dir, 'MERGE_HEAD'), false);
  // A bad resolution is a commit-stage failure too.
  await abortConflict({ run, hooksDir, repoDir, session });
  const again = await startConflict({ run, hooksDir, repoDir, worktreesDir, number: 7, base: 'main', headRef: 'feature' });
  await assert.rejects(finishConflict({ run, hooksDir, session: again, results: [{ path: '../x', text: 'x' }] }), e => e.stage === 'commit');
  await abortConflict({ run, hooksDir, repoDir, session: again });
});

const bytes = (...b) => Buffer.from(b);
const binScenario = () => scenario({
  base: { 'img.bin': bytes(0, 1, 2, 3, 0xff), 'latin.txt': Buffer.from('caf\xe9 one\n', 'latin1'), 'a.txt': 'one\n' },
  feature: { 'img.bin': bytes(0, 9, 9, 9, 0xfe), 'latin.txt': Buffer.from('caf\xe9 feature\n', 'latin1'), 'a.txt': 'feature\n' },
  main: { 'img.bin': bytes(0, 7, 7, 7, 0x80, 0xc3), 'latin.txt': Buffer.from('caf\xe9 main\n', 'latin1'), 'a.txt': 'main\n' },
});

test('binary and non-UTF-8 conflicted files are marked binary with no text', async () => {
  const { repoDir, worktreesDir, hooksDir } = await binScenario();
  const session = await startConflict({ run, hooksDir, repoDir, worktreesDir, number: 7, base: 'main', headRef: 'feature' });
  const by = Object.fromEntries(session.files.map(f => [f.path, f]));
  for (const p of ['img.bin', 'latin.txt']) {
    assert.equal(by[p].kind, 'binary', p);
    assert.equal(by[p].ours, null);
    assert.equal(by[p].theirs, null);
    assert.equal(by[p].merged, null);
    assert.equal(by[p].hasOurs, true);
    assert.equal(by[p].hasTheirs, true);
  }
  assert.equal(by['a.txt'].kind, 'text');
  assert.equal(by['a.txt'].ours, 'feature\n');
  // No temporary files left in the worktree.
  assert.equal(fs.readdirSync(session.dir).some(n => n.startsWith('.merge_file')), false);
  // A binary file takes only a choice.
  await assert.rejects(finishConflict({ run, hooksDir, session, results: [{ path: 'img.bin', text: 'x' }, { path: 'latin.txt', choice: 'ours' }, { path: 'a.txt', text: 'x\n' }] }),
    e => e.stage === 'commit' && /img\.bin/.test(e.message));
  await abortConflict({ run, hooksDir, repoDir, session });
});

test('a binary conflict is never rewritten: theirs commits the base blob byte for byte, ours and delete work too', async () => {
  const { origin, repoDir, worktreesDir, hooksDir } = await binScenario();
  const session = await startConflict({ run, hooksDir, repoDir, worktreesDir, number: 7, base: 'main', headRef: 'feature' });
  const featureLatin = (await run(origin, ['rev-parse', 'refs/heads/feature:latin.txt'])).trim();
  await finishConflict({ run, hooksDir, session, results: [
    { path: 'img.bin', choice: 'theirs' }, { path: 'latin.txt', choice: 'ours' }, { path: 'a.txt', text: 'both\n' },
  ] });
  const blob = async (ref, p) => (await run(origin, ['rev-parse', `${ref}:${p}`])).trim();
  assert.equal(await blob('refs/heads/feature', 'img.bin'), await blob('refs/heads/main', 'img.bin'));
  assert.equal(await blob('refs/heads/feature', 'latin.txt'), featureLatin);
  // Byte for byte, not just the same object name.
  const raw = await new Promise((res, rej) => execFile('git', ['cat-file', 'blob', 'refs/heads/feature:img.bin'], { cwd: origin, encoding: 'buffer' }, (e, out) => (e ? rej(e) : res(out))));
  assert.deepEqual(raw, bytes(0, 7, 7, 7, 0x80, 0xc3));

  const { origin: o2, repoDir: r2, worktreesDir: w2, hooksDir: h2 } = await binScenario();
  const s2 = await startConflict({ run, hooksDir: h2, repoDir: r2, worktreesDir: w2, number: 7, base: 'main', headRef: 'feature' });
  await finishConflict({ run, hooksDir: h2, session: s2, results: [
    { path: 'img.bin', choice: 'delete' }, { path: 'latin.txt', choice: 'theirs' }, { path: 'a.txt', text: 'both\n' },
  ] });
  const names = (await run(o2, ['ls-tree', '--name-only', 'refs/heads/feature'])).split('\n');
  assert.equal(names.includes('img.bin'), false);
  assert.equal((await run(o2, ['rev-parse', 'refs/heads/feature:latin.txt'])).trim(), (await run(o2, ['rev-parse', 'refs/heads/main:latin.txt'])).trim());
});

test('a binary resolution survives a retry after a failed commit', async () => {
  const { origin, repoDir, worktreesDir, hooksDir } = await binScenario();
  const session = await startConflict({ run, hooksDir, repoDir, worktreesDir, number: 7, base: 'main', headRef: 'feature' });
  const results = [{ path: 'img.bin', choice: 'theirs' }, { path: 'latin.txt', choice: 'ours' }, { path: 'a.txt', text: 'both\n' }];
  const noCommit = (cwd, args, input) => (cmdOf(args) === 'commit' ? Promise.reject(new Error('no')) : run(cwd, args, input));
  await assert.rejects(finishConflict({ run: noCommit, hooksDir, session, results }), e => e.stage === 'commit');
  await finishConflict({ run, hooksDir, session, results });
  assert.equal((await run(origin, ['rev-parse', 'refs/heads/feature:img.bin'])).trim(), (await run(origin, ['rev-parse', 'refs/heads/main:img.bin'])).trim());
});
