// Live Share serves the project on a fixed local port, so any web page could embed its files with <script> or <img>.
// It now serves under a random per-session path, with a SameSite=Strict cookie for root-relative URLs
// (SECURITY_AUDIT.md finding 9).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createLiveHandler, newLiveToken, LIVE_RELOAD } = require('../src/main/liveserver');

async function live(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'breeze-live-'));
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  put('index.html', '<html><body><script src="/app.js"></script>home</body></html>');
  put('app.js', 'console.log("app")');
  put('site/index.html', '<html><body>site</body></html>');
  put('.env', 'API_KEY=secret');
  const token = newLiveToken();
  const clients = new Set();
  const server = http.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  server.on('request', createLiveHandler({ port, token, root: () => dir, addClient: res => clients.add(res) }));
  t.after(() => { for (const c of clients) c.end(); server.closeAllConnections(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  // headers: extra request headers. Resolves with the status, headers and body (the event stream only its first chunk).
  const get = (p, headers = {}) => new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => { body += d; if (/event-stream/.test(res.headers['content-type'] || '')) { resolve({ status: res.statusCode, headers: res.headers, body }); req.destroy(); } });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', e => (e.code === 'ECONNRESET' ? undefined : reject(e)));
  });
  return { token, port, get, clients };
}
const cookieOf = res => String(res.headers['set-cookie'] || '').split(';')[0];

test('newLiveToken is long, URL-safe and different every time', () => {
  const a = newLiveToken(), b = newLiveToken();
  assert.match(a, /^[A-Za-z0-9_-]{32,}$/);
  assert.notEqual(a, b);
});

test('Live Share serves the project under its token path and sets a strict cookie there', async t => {
  const { token, get } = await live(t);
  const home = await get(`/${token}/`);
  assert.equal(home.status, 200);
  assert.match(home.body, /home/);
  assert.match(home.body, new RegExp(`EventSource\\('/${token}/${LIVE_RELOAD}'\\)`)); // the reload stream needs the token too
  const cookie = String(home.headers['set-cookie']);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  assert.match(cookie, /Path=\//);
  assert.ok(cookie.includes(token));
  assert.equal(home.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(home.headers['referrer-policy'], 'no-referrer');
  assert.match((await get(`/${token}/site/`)).body, /site/);
  assert.equal((await get(`/${token}/app.js`)).status, 200);
  const bare = await get(`/${token}`);
  assert.equal(bare.status, 302);
  assert.equal(bare.headers.location, `/${token}/`);
});

test('Live Share answers 404 without the token, the reload stream included', async t => {
  const { token, get, clients } = await live(t);
  for (const p of ['/', '/index.html', '/app.js', `/${LIVE_RELOAD}`, '/site/', `/${token.slice(0, -1)}/`, `/${token}x/`, `/x${token}/`]) {
    const r = await get(p);
    assert.equal(r.status, 404, p);
    assert.doesNotMatch(r.body, /home|app|site/, p);
  }
  assert.equal(clients.size, 0);
  const stream = await get(`/${token}/${LIVE_RELOAD}`);
  assert.equal(stream.status, 200);
  assert.match(stream.headers['content-type'], /text\/event-stream/);
});

test('root-relative URLs work for the page that has the cookie, and only from the same origin', async t => {
  const { token, port, get } = await live(t);
  const cookie = cookieOf(await get(`/${token}/`));
  assert.ok(cookie);
  // What the page itself asks for: <script src="/app.js">.
  assert.equal((await get('/app.js', { cookie, 'sec-fetch-site': 'same-origin' })).status, 200);
  assert.equal((await get('/app.js', { cookie })).status, 200); // a browser without Fetch Metadata
  assert.equal((await get('/', { cookie, 'sec-fetch-site': 'none' })).status, 200);
  // Another site, or another port on this computer (same site, not same origin), gets nothing even with the cookie.
  assert.equal((await get('/app.js', { cookie, 'sec-fetch-site': 'cross-site' })).status, 404);
  assert.equal((await get('/app.js', { cookie, 'sec-fetch-site': 'same-site' })).status, 404);
  // A wrong or old cookie is no key.
  assert.equal((await get('/app.js', { cookie: 'breeze_live_' + port + '=nope', 'sec-fetch-site': 'same-origin' })).status, 404);
  assert.equal((await get('/app.js', { cookie: cookie.replace(token, newLiveToken()), 'sec-fetch-site': 'same-origin' })).status, 404);
  // The reload stream wants the token in its path, cookie or not.
  assert.equal((await get(`/${LIVE_RELOAD}`, { cookie, 'sec-fetch-site': 'same-origin' })).status, 404);
});

test('Live Share keeps its Host check and still hides .env', async t => {
  const { token, get } = await live(t);
  assert.equal((await get(`/${token}/`, { host: 'evil.example:80' })).status, 403);
  assert.equal((await get(`/${token}/.env`)).status, 404);
});
