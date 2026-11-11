const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { isInside, resolveUnder, resolveReal, isGitPath, isPageUrl } = require('../src/main/pathguard');

// A project folder and a folder next to it, outside the project.
function sandbox(t) {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'breeze-guard-'));
  t.after(() => fs.rmSync(top, { recursive: true, force: true }));
  const project = path.join(top, 'project');
  const outside = path.join(top, 'outside');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  return { project, outside };
}
// A folder link: a junction on Windows (no admin rights needed), a symlink elsewhere.
const linkDir = (target, at) => fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');

test('resolveUnder keeps paths inside the base', () => {
  const base = path.resolve('/proj');
  assert.equal(resolveUnder(base, 'src/a.js'), path.join(base, 'src', 'a.js'));
  assert.equal(resolveUnder(base, ''), base);
  assert.throws(() => resolveUnder(base, '../x'), /outside the project/);
  assert.throws(() => resolveUnder(base, 'src/../../x'), /outside the project/);
  assert.throws(() => resolveUnder(base, path.resolve('/elsewhere/x')), /outside the project/);
});

test('resolveUnder allows names that only start with two dots', () => {
  const base = path.resolve('/proj');
  assert.equal(resolveUnder(base, '..notes.md'), path.join(base, '..notes.md'));
  assert.ok(isInside(base, path.join(base, '..cache', 'x')));
});

test('resolveReal accepts real files and files not created yet', async t => {
  const { project } = sandbox(t);
  fs.writeFileSync(path.join(project, 'src', 'a.js'), '');
  assert.equal(await resolveReal(project, 'src/a.js'), path.join(project, 'src', 'a.js'));
  assert.equal(await resolveReal(project, 'new/deep/b.js'), path.join(project, 'new', 'deep', 'b.js'));
});

test('resolveReal refuses a link that points outside the project', async t => {
  const { project, outside } = sandbox(t);
  linkDir(outside, path.join(project, 'escape'));
  await assert.rejects(resolveReal(project, 'escape/secret.txt'), /links outside the project/);
  await assert.rejects(resolveReal(project, 'escape/new-file.txt'), /links outside the project/);
  await assert.rejects(resolveReal(project, 'escape'), /links outside the project/);
});

test('resolveReal allows a link that stays inside the project', async t => {
  const { project } = sandbox(t);
  linkDir(path.join(project, 'src'), path.join(project, 'alias'));
  assert.equal(await resolveReal(project, 'alias/x.js'), path.join(project, 'alias', 'x.js'));
});

test('resolveReal works when the project folder itself is reached through a link', async t => {
  const { project } = sandbox(t);
  const via = path.join(path.dirname(project), 'via');
  linkDir(project, via);
  assert.equal(await resolveReal(via, 'src/a.js'), path.join(via, 'src', 'a.js'));
});

test('isGitPath spots the git folder however it is spelled', () => {
  const base = path.resolve('/proj');
  const at = rel => isGitPath(base, path.join(base, rel));
  assert.ok(at('.git/hooks/pre-commit'));
  assert.ok(at('.git/config'));
  assert.ok(at('.git'));
  assert.ok(at('.GIT/hooks/post-checkout'));
  assert.ok(at('.git./hooks/pre-commit'));
  assert.ok(at('.git /config'));
  assert.ok(at('GIT~1/config'));
  assert.ok(at('vendor/lib/.git/config'));
});

test('isGitPath leaves ordinary files alone', () => {
  const base = path.resolve('/proj');
  const at = rel => isGitPath(base, path.join(base, rel));
  assert.ok(!at('.gitignore'));
  assert.ok(!at('.github/workflows/ci.yml'));
  assert.ok(!at('src/git.js'));
  assert.ok(!at('docs/.git-notes.md'));
});

test('isPageUrl matches only the app page', () => {
  const page = pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'breeze.html')).href;
  assert.ok(isPageUrl(page, page));
  assert.ok(isPageUrl(`${page}?x=1#top`, page));
  assert.ok(isPageUrl(page.toUpperCase().replace('FILE:', 'file:'), page, 'win32'));
  assert.ok(!isPageUrl(page.toUpperCase().replace('FILE:', 'file:'), page, 'linux'));
  assert.ok(!isPageUrl(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'evil.html')).href, page));
  assert.ok(!isPageUrl(pathToFileURL(path.join(os.tmpdir(), 'project', 'index.html')).href, page));
  assert.ok(!isPageUrl('https://example.com/breeze.html', page));
  assert.ok(!isPageUrl('file:///%E0%A4%A', page));
  assert.ok(!isPageUrl(undefined, page));
});

test('main.ts checks every navigation of the window against breeze.html', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.ts'), 'utf8');
  assert.match(src, /win\.webContents\.on\('will-navigate', \(e, url\) => \{\s*if \(!isFileUrl\(url, APP_PAGE\)\) e\.preventDefault\(\);/);
});

test('main.ts only runs the install commands the tools list offers', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.ts'), 'utf8');
  assert.match(src, /handle\('sys:runCommand'[\s\S]*?if \(!allowed\.includes\(command\)\) return false;[\s\S]*?spawn\(/);
});

test('main.ts passes Extra effort to Codex and Claude Code as xhigh', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.ts'), 'utf8');
  assert.match(src, /extra: 'xhigh'/);
  assert.match(src, /args\.push\('--effort', effort\)/);
});
