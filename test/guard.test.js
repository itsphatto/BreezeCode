const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { isFileUrl, resolveUnder, blockedRel, agentBlocked, isLocalHost, safeGitArgs, shellCommand } = require('../src/main/guard');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'breeze-guard-'));
// A link to a folder: a junction on Windows (no admin rights needed), a symlink elsewhere.
const linkDir = (target, at) => fs.symlinkSync(target, at, 'junction');

test('isFileUrl accepts only the page itself, ignoring query and hash', () => {
  const page = path.join(tmp(), 'breeze.html');
  const url = pathToFileURL(page).href;
  assert.equal(isFileUrl(url, page), true);
  assert.equal(isFileUrl(`${url}?t=1#top`, page), true);
  assert.equal(isFileUrl(pathToFileURL(path.join(path.dirname(page), 'evil.html')).href, page), false);
  assert.equal(isFileUrl('https://example.com/breeze.html', page), false);
  assert.equal(isFileUrl(undefined, page), false);
  if (process.platform === 'win32') assert.equal(isFileUrl(url.toUpperCase().replace('FILE:', 'file:'), page), true);
});

test('resolveUnder keeps paths inside the folder', () => {
  const base = tmp();
  assert.equal(resolveUnder(base, 'src/app.js'), path.join(base, 'src', 'app.js'));
  assert.equal(resolveUnder(base, '.'), base);
  assert.equal(resolveUnder(base, '..foo'), path.join(base, '..foo')); // a name, not a way out
  assert.throws(() => resolveUnder(base, '../x'), /outside the project/);
  assert.throws(() => resolveUnder(base, path.join(os.tmpdir(), 'x')), /outside the project/);
});

test('resolveUnder refuses a link that leads out of the folder', () => {
  const base = tmp(), outside = tmp();
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
  linkDir(outside, path.join(base, 'shared'));
  assert.throws(() => resolveUnder(base, 'shared/secret.txt'), /outside the project/);
  assert.throws(() => resolveUnder(base, 'shared/new-file.txt'), /outside the project/); // not there yet
  assert.throws(() => resolveUnder(base, 'shared'), /outside the project/);
});

test('resolveUnder allows a link that stays inside, and a folder opened through a link', () => {
  const base = tmp();
  fs.mkdirSync(path.join(base, 'real'));
  linkDir(path.join(base, 'real'), path.join(base, 'alias'));
  assert.equal(resolveUnder(base, 'alias/a.txt'), path.join(base, 'alias', 'a.txt'));
  const viaLink = path.join(tmp(), 'project');
  linkDir(base, viaLink);
  assert.equal(resolveUnder(viaLink, 'real/a.txt'), path.join(viaLink, 'real', 'a.txt'));
});

test('resolveUnder refuses a broken link, since a write would follow it', () => {
  const base = tmp(), target = tmp();
  linkDir(target, path.join(base, 'dangling'));
  fs.rmSync(target, { recursive: true });
  assert.throws(() => resolveUnder(base, 'dangling'), /outside the project/);
  assert.throws(() => resolveUnder(base, 'dangling/new.txt'), /outside the project/);
});

test('blockedRel keeps agents away from secrets and the .git folder', () => {
  for (const p of ['.env', 'config/.env.local', '.envrc', '.ENV']) assert.match(blockedRel(p), /holds secrets/, p);
  for (const p of ['.git', '.git/config', '.GIT/hooks/pre-commit', 'sub\\.git\\config']) assert.match(blockedRel(p), /\.git folder/, p);
  for (const p of ['src/app.js', 'docs/environment.md', '.gitignore', '.github/workflows/ci.yml', '.']) assert.equal(blockedRel(p), null, p);
});

test('agentBlocked also catches .git reached through another name', () => {
  const base = tmp();
  fs.mkdirSync(path.join(base, '.git'));
  linkDir(path.join(base, '.git'), path.join(base, 'innocent'));
  assert.match(agentBlocked(base, path.join(base, 'innocent', 'config')), /\.git folder/);
  assert.equal(agentBlocked(base, path.join(base, 'src', 'app.js')), null);
});

test('safeGitArgs turns off config-driven commands', () => {
  assert.deepEqual(safeGitArgs(['status', '--porcelain']), ['-c', 'core.fsmonitor=false', 'status', '--porcelain']);
  assert.deepEqual(safeGitArgs(['diff', '--', 'a']), ['-c', 'core.fsmonitor=false', 'diff', '--no-ext-diff', '--no-textconv', '--', 'a']);
  assert.deepEqual(safeGitArgs(['show', 'abc']).slice(2, 5), ['show', '--no-ext-diff', '--no-textconv']);
});

// A repository whose config runs a command on `git status` (core.fsmonitor) and on `git diff` (diff.external).
let hasGit = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { hasGit = false; }
test('a hostile repository config runs nothing through safeGitArgs', { skip: !hasGit && 'git is not installed' }, () => {
  const repo = tmp();
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString();
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git('add', 'a.txt');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'a');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  const fwd = p => p.split(path.sep).join('/');
  const hook = (name) => {
    const script = path.join(repo, `${name}.sh`);
    fs.writeFileSync(script, `#!/bin/sh\necho ran > "${fwd(path.join(repo, `${name}.hit`))}"\n`, { mode: 0o755 });
    return fwd(script);
  };
  git('config', 'core.fsmonitor', hook('fsmonitor'));
  git('config', 'diff.external', hook('extdiff'));
  const ran = name => fs.existsSync(path.join(repo, `${name}.hit`));

  git(...safeGitArgs(['status', '--porcelain']));
  git(...safeGitArgs(['diff', '--no-color', '--', 'a.txt']));
  assert.equal(ran('fsmonitor'), false, 'core.fsmonitor ran');
  assert.equal(ran('extdiff'), false, 'diff.external ran');

  // The same calls without the guard do run them, so the test above means something.
  git('status', '--porcelain');
  git('diff', '--no-color', '--', 'a.txt');
  assert.equal(ran('fsmonitor') && ran('extdiff'), true);
});

test('shellCommand quotes the program and only lets plain arguments through', () => {
  assert.equal(shellCommand('C:\\Users\\John Doe\\npm\\codex.cmd', ['exec', '--json', '-m', 'gpt-5.1', '-']), '"C:\\Users\\John Doe\\npm\\codex.cmd" exec --json -m gpt-5.1 -');
  for (const bad of ['a&b', 'a b', '"x"', '%PATH%', '|calc', '']) assert.throws(() => shellCommand('codex.cmd', [bad]), /Refusing/, bad);
  assert.throws(() => shellCommand('C:\\x"\\codex.cmd', []), /Can't run/);
});

test('a .cmd shim in a folder with a space runs through shellCommand', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  const dir = path.join(tmp(), 'John Doe');
  fs.mkdirSync(dir);
  const bin = path.join(dir, 'codex.cmd');
  fs.writeFileSync(bin, '@echo shim got %*\r\n');
  const out = await new Promise((res, rej) => {
    const c = spawn(shellCommand(bin, ['exec', '--json', '-']), { shell: true, windowsHide: true });
    let text = '';
    c.stdout.on('data', d => { text += d; });
    c.stderr.on('data', d => { text += d; });
    c.on('error', rej);
    c.on('close', code => res({ code, text: text.trim() }));
  });
  assert.deepEqual(out, { code: 0, text: 'shim got exec --json -' });
});

test('isLocalHost accepts only this computer on the right port', () => {
  assert.equal(isLocalHost('127.0.0.1:2026', 2026), true);
  assert.equal(isLocalHost('LOCALHOST:2026', 2026), true);
  assert.equal(isLocalHost('[::1]:2026', 2026), true);
  assert.equal(isLocalHost('evil.example:2026', 2026), false); // DNS rebinding
  assert.equal(isLocalHost('127.0.0.1:3000', 2026), false);
  assert.equal(isLocalHost('127.0.0.1', 2026), false);
  assert.equal(isLocalHost(undefined, 2026), false);
});

test('autoCommand lets plain checks run without asking, and nothing that could be more', () => {
  const { autoCommand } = require('../src/main/guard');
  for (const ok of ['git status', 'git diff src/a.js', 'git log --oneline -5', 'node --check src/app.js', 'tsc', 'npx tsc --noEmit', 'npm test', 'npm run build', 'pnpm run lint:fix'])
    assert.equal(autoCommand(ok), true, ok);
  for (const no of ['', 'rm -rf .', 'type .env', 'git status && del x', 'git diff --output=x.txt', 'npm test > out.txt', 'npm run build | more', 'echo %PATH%', 'node -e "x"', 'git push', 'npm install left-pad', 'git log $(whoami)'])
    assert.equal(autoCommand(no), false, no);
  assert.equal(autoCommand('npm test', { packageChanged: true }), false); // the agent changed what the script runs
});

test('cleanEnv drops variables that look like secrets', () => {
  const { cleanEnv } = require('../src/main/guard');
  assert.deepEqual(cleanEnv({ PATH: '/bin', OPENAI_API_KEY: 'x', GITHUB_TOKEN: 'y', DB_PASSWORD: 'z', HOME: '/h' }), { PATH: '/bin', HOME: '/h' });
});
