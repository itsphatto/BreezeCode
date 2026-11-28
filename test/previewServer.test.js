// breeze-preview:// serves the project to the preview frame. It must refuse what agentBlocked refuses (.env files and
// .git), whichever way the path is spelled, as Live Share does (SECURITY_AUDIT.md finding 8).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { fileURLToPath } = require('node:url');

// previewServer reads files through Electron's net.fetch; outside Electron a file:// fetch is stood in for.
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: {
    net: {
      fetch: async url => {
        const p = fileURLToPath(url);
        const body = fs.readFileSync(p); // throws for a missing file or a folder, as net.fetch fails
        return new Response(body, { status: 200, headers: { 'content-type': /\.html?$/i.test(p) ? 'text/html' : 'text/plain' } });
      },
    },
  },
};
const { createPreviewHandler } = require('../src/main/previewServer');
const { resolveUnder } = require('../src/main/guard');

const isWin = process.platform === 'win32';
const linkDir = (target, at) => fs.symlinkSync(target, at, isWin ? 'junction' : 'dir');

function project(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'breeze-preview-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  put('index.html', '<html><head></head><body>home</body></html>');
  put('app.js', 'console.log(1)');
  put('docs/index.html', '<html><head></head><body>docs</body></html>');
  put('.env', 'API_KEY=secret');
  put('.env.local', 'API_KEY=secret');
  put('.env.example', 'API_KEY=');
  put('config/.env.production', 'API_KEY=secret');
  put('.git/config', '[core]\n\tsshCommand = evil');
  put('.git/index.html', '<html><body>git</body></html>');
  put('.git/hooks/pre-commit', 'evil');
  const serve = createPreviewHandler(rel => resolveUnder(dir, rel));
  const get = async rel => {
    const res = await serve(new Request(`breeze-preview://project/${rel}`));
    return { status: res.status, text: await res.text() };
  };
  return { dir, get };
}

test('preview still serves project files, folders as index.html, and .env templates', async t => {
  const { get } = project(t);
  assert.equal((await get('app.js')).status, 200);
  assert.match((await get('')).text, /home/);
  assert.match((await get('docs/')).text, /docs/);
  const example = await get('.env.example');
  assert.equal(example.status, 200);
  assert.equal(example.text, 'API_KEY=');
});

test('preview refuses .env files with 404', async t => {
  const { get } = project(t);
  for (const rel of ['.env', '.env.local', 'config/.env.production', '%2Eenv', 'docs/../.env', '.ENV']) {
    const r = await get(rel);
    assert.equal(r.status, 404, rel);
    assert.doesNotMatch(r.text, /secret/, rel);
  }
});

test('preview refuses the .git folder, its files and its index.html', async t => {
  const { get } = project(t);
  for (const rel of ['.git/config', '.git/hooks/pre-commit', '.git/', '.git', '.GIT/config', '%2egit/config']) {
    const r = await get(rel);
    assert.equal(r.status, 404, rel);
    assert.doesNotMatch(r.text, /evil|git/, rel);
  }
});

test('preview refuses links into .git and to .env, including a linked folder\'s index.html', async t => {
  const { dir, get } = project(t);
  linkDir(path.join(dir, '.git'), path.join(dir, 'site'));
  assert.equal((await get('site/config')).status, 404);
  assert.equal((await get('site/')).status, 404); // a folder whose index.html is really .git/index.html
  assert.equal((await get('site')).status, 404);
  if (!isWin) {
    fs.symlinkSync(path.join(dir, '.env'), path.join(dir, 'public.txt'));
    assert.equal((await get('public.txt')).status, 404);
  }
});

test('preview refuses Windows spellings of .git and .env (short names, trailing dots, streams)', { skip: !isWin }, async t => {
  const { dir, get } = project(t);
  const spellings = ['.git./config', '.git%20/config', '.git::$INDEX_ALLOCATION/config', '.env.', '.env::$DATA', '.env%20'];
  // 8.3 names exist only where the volume makes them.
  const short = name => { try { return execFileSync('cmd.exe', ['/d', '/c', `for %I in ("${path.join(dir, name)}") do @echo %~snxI`], { encoding: 'utf8' }).trim(); } catch { return ''; } };
  for (const name of ['.git', '.env']) {
    const s = short(name);
    if (s && s.toLowerCase() !== name) spellings.push(name === '.git' ? `${s}/config` : s);
  }
  for (const rel of spellings) {
    const r = await get(rel);
    assert.equal(r.status, 404, rel);
    assert.doesNotMatch(r.text, /secret|evil/, rel);
  }
});
