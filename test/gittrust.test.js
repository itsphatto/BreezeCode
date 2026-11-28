// A folder whose .git came from someone else (a zip, a USB stick, a shared drive) can run programs through its own
// git config and hooks whenever Breeze runs git. gittrust.ts finds those settings, and until the user trusts the
// repository Breeze's git calls run with them switched off or are refused (SECURITY_AUDIT.md finding 4).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { inspectRepo, riskyKey, gitReadOnly, gateGitArgs, isTrusted, trustEntries, UNTRUSTED } = require('../src/main/gittrust');
const { safeGitArgs } = require('../src/main/guard');

const isWin = process.platform === 'win32';
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'breeze-trust-'));
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
const emptyHooks = path.join(tmpRoot, 'no-hooks');
fs.mkdirSync(emptyHooks);

// Real git, as main.ts runs it: stdout, or a rejection with stderr on the error.
const exec = (cwd, args, input) => new Promise((resolve, reject) => {
  const child = execFile('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
    if (err) { err.stderr = stderr; reject(err); } else resolve(stdout);
  });
  child.stdin.end(input ?? '');
});
let n = 0;
async function repo(config = {}) {
  const dir = path.join(tmpRoot, `r${++n}`);
  fs.mkdirSync(dir);
  await exec(dir, ['init', '-q']);
  await exec(dir, ['config', 'user.name', 'Test']);
  await exec(dir, ['config', 'user.email', 'test@example.com']);
  await exec(dir, ['config', 'core.autocrlf', 'false']);
  for (const [k, v] of Object.entries(config)) await exec(dir, ['config', k, v]);
  return dir;
}
// A hook that leaves a mark when git runs it.
function hook(dir, name, mark, hooksDir = path.join(dir, '.git', 'hooks')) {
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(hooksDir, name), `#!/bin/sh\necho ran > "${mark.replaceAll('\\', '/')}"\n`, { mode: 0o755 });
}
// A shell command for config values that leaves a mark (sh is Git's own on Windows).
const marker = mark => `sh -c 'echo ran > "${mark.replaceAll('\\', '/')}"; cat'`;
const keys = risk => risk.items.map(i => `${i.kind}:${i.name}`).sort();
// What the user's Trust answer stores: every repository the look covered.
const trusting = risk => Object.fromEntries(trustEntries(risk));
// A config-defined hook (hook.<name>.command) leaves its mark without reading stdin.
const hookCmd = mark => `sh -c 'echo ran > "${mark.replaceAll('\\', '/')}"'`;
// A repository inside `parent` that git treats as a submodule: a gitlink in the index, with its own git folder (or a
// .git file pointing at one elsewhere) and one committed file.
async function nestedRepo(parent, rel, { gitFile = false } = {}) {
  const dir = path.join(parent, rel);
  fs.mkdirSync(dir, { recursive: true });
  if (gitFile) await exec(dir, ['init', '-q', '--separate-git-dir', path.join(tmpRoot, `gitdir-${++n}`)]);
  else await exec(dir, ['init', '-q']);
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['core.autocrlf', 'false']]) await exec(dir, ['config', k, v]);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  await exec(dir, ['add', 'a.txt']);
  await exec(dir, ['commit', '-q', '-m', 'one']);
  await exec(parent, ['add', rel]); // records the gitlink (git warns about an embedded repository)
  await exec(parent, ['commit', '-q', '-m', `add ${rel}`]);
  return dir;
}
// Its own filter on its own files, and a changed file for status to look at.
async function plantFilter(dir, mark) {
  await exec(dir, ['config', 'filter.evil.clean', marker(mark)]);
  fs.writeFileSync(path.join(dir, '.gitattributes'), '*.txt filter=evil\n');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
}

test('a plain repository, or no repository, has nothing to trust', async () => {
  const outside = path.join(tmpRoot, 'not-a-repo');
  fs.mkdirSync(outside);
  assert.equal(await inspectRepo(exec, outside), null);
  const dir = await repo({ 'remote.origin.url': 'https://example.com/x.git', 'branch.main.remote': 'origin', 'lfs.url': 'https://example.com/lfs' });
  const risk = await inspectRepo(exec, dir);
  assert.deepEqual(risk.items, []); // the .sample hooks git init writes don't count
  assert.equal(isTrusted(risk, {}), true);
  assert.deepEqual(gateGitArgs(['commit', '-F', '-'], { risk, store: {}, hooksDir: emptyHooks }), safeGitArgs(['commit', '-F', '-']));
});

test('riskyKey flags settings that name programs, and only those', () => {
  const risky = [
    ['filter.lfs.clean', 'git-lfs clean -- %f'], ['filter.x.smudge', 'x'], ['filter.x.process', 'x'], ['core.hooksPath', '.husky/_'],
    ['core.sshCommand', 'ssh -i k'], ['core.fsmonitor', 'x'], ['core.askPass', 'x'], ['core.editor', 'vim'], ['core.pager', 'less'],
    ['core.gitProxy', 'x'], ['core.alternateRefsCommand', 'x'], ['sequence.editor', 'x'], ['credential.helper', '!evil'],
    ['credential.https://example.com.helper', 'x'], ['diff.x.textconv', 'x'], ['diff.x.command', 'x'], ['merge.x.driver', 'x'],
    ['gpg.program', 'x'], ['gpg.ssh.program', 'x'], ['gpg.ssh.defaultKeyCommand', 'x'], ['remote.origin.uploadpack', 'x'],
    ['remote.origin.receivepack', 'x'], ['remote.origin.vcs', 'x'], ['pager.log', 'x'], ['include.path', '../evil'],
    ['includeIf.gitdir:/x/.path', 'evil'], ['submodule.a.update', '!sh evil'], ['protocol.allow', 'always'], ['protocol.ext.allow', 'user'],
    ['lfs.customtransfer.x.path', 'x'], ['lfs.extension.x.clean', 'x'], ['trailer.x.command', 'x'], ['ssh.variant', 'x'],
    // From git help config (2.55): more keys that name a program.
    ['diff.external', 'evil'], ['hook.evil.command', 'evil'], ['gc.recentObjectsHook', 'evil'], ['interactive.diffFilter', 'evil'],
    ['imap.tunnel', 'evil'], ['difftool.x.cmd', 'evil'], ['difftool.x.path', 'evil'], ['mergetool.x.cmd', 'evil'], ['mergetool.x.path', 'evil'],
    ['guitool.x.cmd', 'evil'], ['man.x.cmd', 'evil'], ['man.x.path', 'evil'], ['browser.x.cmd', 'evil'], ['browser.x.path', 'evil'],
    ['web.browser', 'evil'], ['instaweb.httpd', 'evil'], ['instaweb.browser', 'evil'], ['sendemail.sendmailCmd', 'evil'],
    ['sendemail.toCmd', 'evil'], ['sendemail.ccCmd', 'evil'], ['sendemail.headerCmd', 'evil'], ['sendemail.smtpServer', '/usr/sbin/evil'],
  ];
  for (const [k, v] of risky) assert.equal(riskyKey(k.toLowerCase(), v), true, k);
  const fine = [['user.name', 'x'], ['core.autocrlf', 'true'], ['remote.origin.url', 'https://x'], ['branch.main.merge', 'refs/heads/main'],
    ['submodule.a.update', 'checkout'], ['protocol.ext.allow', 'never'], ['lfs.url', 'https://x'], ['filter.lfs.required', 'true'], ['core.bare', 'false'],
    ['sendemail.smtpServer', 'smtp.example.com'], ['hook.evil.parallel', 'true'], ['diff.tool', 'meld']];
  for (const [k, v] of fine) assert.equal(riskyKey(k.toLowerCase(), v), false, k);
});

test('inspectRepo finds risky local config, included files and executable hooks', async () => {
  const dir = await repo({ 'filter.evil.clean': 'evil', 'core.sshCommand': 'evil', 'user.signingkey': 'k' });
  const extra = path.join(tmpRoot, `include-${n}.cfg`);
  fs.writeFileSync(extra, '[credential]\n\thelper = !evil\n');
  await exec(dir, ['config', 'include.path', extra]);
  hook(dir, 'pre-commit', path.join(tmpRoot, 'unused'));
  fs.writeFileSync(path.join(dir, '.git', 'hooks', 'notes.txt.sample'), 'x');
  const risk = await inspectRepo(exec, dir);
  assert.deepEqual(keys(risk), ['config:core.sshcommand', 'config:credential.helper', 'config:filter.evil.clean', 'config:include.path', 'hook:pre-commit']);
  assert.deepEqual(risk.drivers.filter, ['evil']);
  assert.equal(isTrusted(risk, {}), false);
  assert.match(risk.fingerprint, /^[0-9a-f]{64}$/);
});

test('the fingerprint changes when a risky setting or a hook changes, and only then', async () => {
  const dir = await repo({ 'core.hooksPath': '.husky/_' });
  hook(dir, 'pre-commit', path.join(tmpRoot, 'a'), path.join(dir, '.husky', '_'));
  const first = await inspectRepo(exec, dir);
  assert.deepEqual(keys(first), ['config:core.hookspath', 'hook:pre-commit']);
  const store = { [first.repo]: first.fingerprint };
  assert.equal(isTrusted(first, store), true);
  await exec(dir, ['config', 'user.name', 'Someone else']); // not a risky setting
  assert.equal(isTrusted(await inspectRepo(exec, dir), store), true);
  hook(dir, 'pre-commit', path.join(tmpRoot, 'b'), path.join(dir, '.husky', '_')); // the hook's contents changed
  assert.equal(isTrusted(await inspectRepo(exec, dir), store), false);
  const second = await inspectRepo(exec, dir);
  await exec(dir, ['config', 'core.sshCommand', 'evil']); // a new risky setting
  assert.equal(isTrusted(await inspectRepo(exec, dir), { [second.repo]: second.fingerprint }), false);
});

test('gitReadOnly lets through only calls that run no hooks and change nothing', () => {
  for (const a of [['status', '--porcelain'], ['log', '--all'], ['show', 'HEAD'], ['diff', '--', 'a'], ['rev-parse', 'HEAD'], ['remote'],
    ['remote', 'get-url', 'origin'], ['branch', '--format=%(refname:short)'], ['for-each-ref'], ['check-ignore', '-q', '--', 'a'],
    ['check-ref-format', '--branch', 'x'], ['ls-files', '-u'], ['-c', 'core.hooksPath=/x', 'status'], ['worktree', 'prune'], ['worktree', 'list']]) {
    assert.equal(gitReadOnly(a), true, a.join(' '));
  }
  for (const a of [['add', '-A'], ['commit', '-F', '-'], ['fetch', '--all'], ['pull', '--ff-only'], ['push'], ['switch', 'x'],
    ['branch', '-D', '--', 'x'], ['restore', '--staged', '--', 'a'], ['rm', '--cached', 'a'], ['init'], ['merge', 'x'], ['checkout', 'x'],
    ['worktree', 'add', 'x'], ['update-ref', '-d', 'x'], ['remote', 'add', 'x', 'y'], ['config', 'x', 'y'], ['submodule', 'update'], []]) {
    assert.equal(gitReadOnly(a), false, a.join(' '));
  }
});

test('an untrusted risky repository: reads run with its programs off, everything else is refused', async () => {
  const dir = await repo({ 'filter.evil.clean': 'evil' });
  const risk = await inspectRepo(exec, dir);
  const o = { risk, store: {}, hooksDir: emptyHooks };
  for (const a of [['add', '-A'], ['commit', '-F', '-'], ['fetch', '--all', '--prune'], ['pull', '--ff-only'], ['push'], ['switch', 'main'], ['branch', '-D', '--', 'x']]) {
    assert.throws(() => gateGitArgs(a, o), new RegExp(UNTRUSTED), a.join(' '));
  }
  const args = gateGitArgs(['status', '--porcelain'], o);
  assert.deepEqual(args.slice(-3), ['status', '--ignore-submodules=dirty', '--porcelain']);
  for (const pair of [`core.hooksPath=${emptyHooks}`, 'filter.evil.clean=', 'filter.evil.smudge=', 'filter.evil.process=', 'filter.evil.required=false', 'core.fsmonitor=false']) {
    assert.ok(args.includes(pair), pair);
  }
  // Trusted, the same call runs as before.
  assert.deepEqual(gateGitArgs(['add', '-A'], { ...o, store: trusting(risk) }), safeGitArgs(['add', '-A']));
  // Settings Breeze couldn't read are never trusted, and nothing runs.
  const unreadable = { ...risk, unreadable: 'bad config' };
  assert.throws(() => gateGitArgs(['status'], { risk: unreadable, store: trusting(risk), hooksDir: emptyHooks }), /couldn't read/);
  assert.equal(isTrusted(unreadable, { [risk.repo]: risk.fingerprint }), false);
});

test('a hostile repository runs nothing through Breeze\'s git calls until it is trusted', async () => {
  const dir = await repo();
  const marks = { clean: path.join(dir, '..', `clean-${n}`), hook: path.join(dir, '..', `hook-${n}`), fsmon: path.join(dir, '..', `fsmon-${n}`) };
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  await exec(dir, ['add', 'a.txt']);
  await exec(dir, ['commit', '-q', '-m', 'one']);
  // Now the planted settings: what a folder from someone else could carry.
  await exec(dir, ['config', 'filter.evil.clean', marker(marks.clean)]);
  await exec(dir, ['config', 'core.fsmonitor', marker(marks.fsmon)]);
  fs.writeFileSync(path.join(dir, '.gitattributes'), '*.txt filter=evil\n');
  hook(dir, 'post-index-change', marks.hook);
  hook(dir, 'pre-commit', marks.hook);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
  const risk = await inspectRepo(exec, dir);
  const run = args => exec(dir, gateGitArgs(args, { risk, store: {}, hooksDir: emptyHooks }));
  await run(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  await run(['diff', '--no-color', '--', 'a.txt']);
  await run(['log', '--all']);
  await assert.rejects(() => Promise.resolve().then(() => run(['add', '-A'])), new RegExp(UNTRUSTED));
  await assert.rejects(() => Promise.resolve().then(() => run(['commit', '-m', 'x'])), new RegExp(UNTRUSTED));
  for (const m of Object.values(marks)) assert.equal(fs.existsSync(m), false, `${path.basename(m)} ran`);
});

test('a common setup (local LFS-style filter and husky hooks) asks once, then works as before', async () => {
  const dir = await repo();
  const marks = { filter: path.join(tmpRoot, `lfs-${n}`), hook: path.join(tmpRoot, `husky-${n}`) };
  await exec(dir, ['config', 'filter.media.clean', marker(marks.filter)]);
  await exec(dir, ['config', 'filter.media.required', 'true']);
  await exec(dir, ['config', 'core.hooksPath', '.husky/_']);
  hook(dir, 'pre-commit', marks.hook, path.join(dir, '.husky', '_'));
  fs.writeFileSync(path.join(dir, '.gitattributes'), '*.bin filter=media\n'); // named apart from git-lfs's own, which system config may set
  fs.writeFileSync(path.join(dir, 'big.bin'), 'data');
  const risk = await inspectRepo(exec, dir);
  assert.deepEqual(keys(risk), ['config:core.hookspath', 'config:filter.media.clean', 'hook:pre-commit']);
  const store = {};
  assert.equal(isTrusted(risk, store), false);
  store[risk.repo] = risk.fingerprint; // the user answered Trust
  const again = await inspectRepo(exec, dir);
  assert.equal(isTrusted(again, store), true);
  const run = args => exec(dir, gateGitArgs(args, { risk: again, store, hooksDir: emptyHooks }));
  await run(['add', '-A']);
  await run(['commit', '-q', '-m', 'first']);
  assert.equal(fs.existsSync(marks.filter), true, 'the trusted filter ran');
  assert.equal(fs.existsSync(marks.hook), true, 'the trusted hook ran');
});

test('every git call in main.ts goes through the trust gate', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.ts'), 'utf8');
  assert.doesNotMatch(src, /execFile\('git'/, 'git run by name, around the gate');
  // safeGitArgs is applied by gateGitArgs; the one direct use left is cloning into a new, empty folder.
  const direct = src.match(/safeGitArgs\(/g) || [];
  assert.equal(direct.length, 1);
  assert.match(src, /safeGitArgs\(\['clone'/);
  for (const fn of ['async function git(', 'async function runGitIn(']) {
    const body = src.slice(src.indexOf(fn), src.indexOf('\n}\n', src.indexOf(fn)));
    assert.match(body, /gitGate\(/, fn);
  }
});

test('a nested repository (a gitlink with its own .git, at any depth or behind a .git file) runs nothing until trusted', async () => {
  const outer = await repo();
  fs.writeFileSync(path.join(outer, 'r.txt'), 'r\n');
  await exec(outer, ['add', 'r.txt']);
  await exec(outer, ['commit', '-q', '-m', 'r']);
  const inner = await nestedRepo(outer, 'inner');
  const deep = await nestedRepo(inner, 'deep'); // a repository inside the nested one
  await exec(outer, ['add', 'inner']);
  await exec(outer, ['commit', '-q', '-m', 'inner moved']);
  const linked = await nestedRepo(outer, 'vendor/linked', { gitFile: true }); // .git is a file pointing elsewhere
  const marks = { inner: path.join(tmpRoot, `inner-${n}`), deep: path.join(tmpRoot, `deep-${n}`), linked: path.join(tmpRoot, `linked-${n}`) };
  await plantFilter(inner, marks.inner);
  await plantFilter(deep, marks.deep);
  await plantFilter(linked, marks.linked);
  const ran = () => Object.entries(marks).filter(([, m]) => fs.existsSync(m)).map(([k]) => k);
  // The folder's own repository has nothing risky, so reads look at it alone, and never go into the nested ones.
  const look = await inspectRepo(exec, outer);
  assert.deepEqual(look.items, []);
  const read = args => exec(outer, gateGitArgs(args, { risk: look, store: {}, hooksDir: emptyHooks }));
  await read(['status', '--porcelain=v1', '-b', '-z', '--untracked-files=all', '--ignored=matching']);
  await read(['diff', '--no-color']);
  await read(['show', '--numstat', 'HEAD']);
  assert.deepEqual(ran(), []);
  // A call that may run something looks into every nested repository first.
  const full = await inspectRepo(exec, outer, { nested: true });
  assert.deepEqual(full.nested.map(r => r.path).sort(), ['inner', 'inner/deep', 'vendor/linked']);
  for (const r of full.nested) assert.deepEqual(keys(r), ['config:filter.evil.clean'], r.path);
  assert.equal(isTrusted(full, {}), false);
  for (const a of [['add', '-A'], ['commit', '-m', 'x'], ['commit', '-a', '-m', 'x']]) {
    assert.throws(() => gateGitArgs(a, { risk: full, store: {}, hooksDir: emptyHooks }), new RegExp(UNTRUSTED), a.join(' '));
  }
  assert.deepEqual(ran(), []);
  // Trusting covers what was shown, nested repositories included.
  const store = trusting(full);
  assert.equal(isTrusted(await inspectRepo(exec, outer, { nested: true }), store), true);
  assert.deepEqual(gateGitArgs(['add', '-A'], { risk: full, store, hooksDir: emptyHooks }), safeGitArgs(['add', '-A']));
});

test('a nested repository that appears after the look still runs nothing on reads', async () => {
  const outer = await repo();
  fs.writeFileSync(path.join(outer, 'r.txt'), 'r\n');
  await exec(outer, ['add', 'r.txt']);
  await exec(outer, ['commit', '-q', '-m', 'r']);
  const look = await inspectRepo(exec, outer); // what a cached look (or one just before the call) saw: nothing
  const inner = await nestedRepo(outer, 'late');
  const mark = path.join(tmpRoot, `late-${n}`);
  await plantFilter(inner, mark);
  const read = args => exec(outer, gateGitArgs(args, { risk: look, store: {}, hooksDir: emptyHooks }));
  await read(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  await read(['diff', '--no-color', '--', 'late']);
  assert.equal(fs.existsSync(mark), false);
});

test('config-defined hooks (hook.<name>.command) are flagged, and untrusted reads can\'t fire them', async () => {
  const dir = await repo();
  const mark = path.join(tmpRoot, `cfghook-${n}`);
  await exec(dir, ['config', 'hook.evil.command', hookCmd(mark)]);
  await exec(dir, ['config', '--add', 'hook.evil.event', 'pre-commit']);
  await exec(dir, ['config', '--add', 'hook.evil.event', 'post-index-change']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  const risk = await inspectRepo(exec, dir, { nested: true });
  assert.deepEqual(keys(risk), ['config:hook.evil.command']);
  const o = { risk, store: {}, hooksDir: emptyHooks };
  for (const a of [['add', '-A'], ['commit', '-m', 'x']]) assert.throws(() => gateGitArgs(a, o), new RegExp(UNTRUSTED), a.join(' '));
  // git status refreshes and writes the index (this runner doesn't set GIT_OPTIONAL_LOCKS=0), which fires post-index-change.
  await exec(dir, gateGitArgs(['status', '--porcelain'], o));
  await exec(dir, gateGitArgs(['diff'], o));
  assert.equal(fs.existsSync(mark), false);
});
