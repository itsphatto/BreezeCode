const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { toFields, fromDoc, normEmail, sha256hex, FriendsError } = require('../src/main/friends');

// ---- Task 1: codec and email helpers ----

test('toFields/fromDoc round-trip strings, numbers, booleans, null and nested maps', () => {
  const x = { s: 'hi', n: 3, f: 1.5, neg: -7, t: true, f2: false, nil: null, nested: { a: 'b', deep: { z: 1 } }, list: ['a', 2, null] };
  assert.deepEqual(fromDoc({ name: 'projects/p/databases/(default)/documents/users/u1', fields: toFields(x) }), { id: 'u1', ...x });
});

test('toFields writes integers as integerValue strings and others as doubleValue', () => {
  const f = toFields({ n: 3, f: 1.5, d: new Date(Date.UTC(2026, 10, 8)), nil: null });
  assert.deepEqual(f.n, { integerValue: '3' });
  assert.deepEqual(f.f, { doubleValue: 1.5 });
  assert.deepEqual(f.d, { timestampValue: '2026-11-08T00:00:00.000Z' });
  assert.deepEqual(f.nil, { nullValue: null });
});

test('fromDoc turns timestampValue into ms', () => {
  const doc = { name: 'projects/p/databases/(default)/documents/presence/u2', fields: { updatedAt: { timestampValue: '2026-11-08T00:00:00Z' } } };
  assert.equal(fromDoc(doc).updatedAt, Date.UTC(2026, 10, 8));
});

test('SERVER_TIME is left out of fields and reported as a transform', () => {
  const { SERVER_TIME, transformsOf } = require('../src/main/friends');
  const obj = { state: 'online', updatedAt: SERVER_TIME };
  assert.deepEqual(Object.keys(toFields(obj)), ['state']);
  assert.deepEqual(transformsOf(obj), [{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }]);
});

test('normEmail trims and lowercases', () => {
  assert.equal(normEmail('  Bob@X.com '), 'bob@x.com');
  assert.equal(normEmail('bob'), null);
  assert.equal(normEmail('a@b'), null);
  assert.equal(normEmail(''), null);
  assert.equal(normEmail(null), null);
});

test('sha256hex matches node crypto', () => {
  assert.equal(sha256hex('a@b.co'), crypto.createHash('sha256').update('a@b.co').digest('hex'));
});

test('FriendsError carries a code and a readable message', () => {
  const e = new FriendsError('self');
  assert.equal(e.code, 'self');
  assert.equal(e.message, "That's you.");
  assert.ok(e instanceof Error);
});

// ---- Task 2: Firebase session and per-account cache ----

const { firebaseSession, refreshSession, SessionCache } = require('../src/main/friends');

const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });
// Records every call as { url, init, body } and answers from `handler(url, body, init)`.
function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const call = { url, init, body: init.body };
    calls.push(call);
    return handler(url, init.body, init);
  };
  fn.calls = calls;
  return fn;
}
const idpOk = (uid, extra = {}) => reply(200, { localId: uid, idToken: `id-${uid}`, refreshToken: `rt-${uid}`, email: `${uid}@x.com`, expiresIn: '3600', ...extra });

test('firebaseSession sends github.com postBody and maps the response', async () => {
  const f = fakeFetch(() => idpOk('u1', { email: 'Bob@X.com' }));
  const s = await firebaseSession({ apiKey: 'K', provider: 'GitHub', accessToken: 'T', fetch: f, now: () => 1000 });
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].url.includes('accounts:signInWithIdp?key=K'));
  assert.equal(JSON.parse(f.calls[0].body).postBody, 'access_token=T&providerId=github.com');
  assert.deepEqual(s, { uid: 'u1', idToken: 'id-u1', refreshToken: 'rt-u1', email: 'bob@x.com', expiresAt: 1000 + 3600 * 1000 });
});

test('firebaseSession uses google.com for a Google account', async () => {
  const f = fakeFetch(() => idpOk('u1'));
  await firebaseSession({ apiKey: 'K', provider: 'Google', accessToken: 'T', fetch: f });
  assert.equal(JSON.parse(f.calls[0].body).postBody, 'access_token=T&providerId=google.com');
});

test('firebaseSession maps INVALID_IDP_RESPONSE to reauth', async () => {
  const f = fakeFetch(() => reply(400, { error: { message: 'INVALID_IDP_RESPONSE : Error getting access token' } }));
  await assert.rejects(firebaseSession({ apiKey: 'K', provider: 'GitHub', accessToken: 'T', fetch: f }),
    e => e instanceof FriendsError && e.code === 'reauth' && /GitHub/.test(e.message));
});

test('firebaseSession turns a thrown fetch into network', async () => {
  const f = async () => { throw new Error('ENOTFOUND'); };
  await assert.rejects(firebaseSession({ apiKey: 'K', provider: 'GitHub', accessToken: 'T', fetch: f }), e => e.code === 'network');
});

test('refreshSession posts the refresh_token form and maps the response', async () => {
  const f = fakeFetch(() => reply(200, { id_token: 'new-id', refresh_token: 'new-rt', user_id: 'u1', expires_in: '3600' }));
  const s = await refreshSession({ apiKey: 'K', refreshToken: 'rt', email: 'bob@x.com', fetch: f, now: () => 5 });
  assert.ok(f.calls[0].url.startsWith('https://securetoken.googleapis.com/v1/token?key=K'));
  assert.equal(f.calls[0].body, 'grant_type=refresh_token&refresh_token=rt');
  assert.deepEqual(s, { uid: 'u1', idToken: 'new-id', refreshToken: 'new-rt', email: 'bob@x.com', expiresAt: 5 + 3600000 });
});

test('refreshSession reads the email from the id token when it has one', async () => {
  const jwt = `h.${Buffer.from(JSON.stringify({ email: 'Zed@X.com' })).toString('base64url')}.s`;
  const f = fakeFetch(() => reply(200, { id_token: jwt, refresh_token: 'r2', user_id: 'u9', expires_in: '3600' }));
  assert.equal((await refreshSession({ apiKey: 'K', refreshToken: 'rt', fetch: f })).email, 'zed@x.com');
});

test('refreshSession maps a dead refresh token to reauth', async () => {
  const f = fakeFetch(() => reply(400, { error: { message: 'TOKEN_EXPIRED' } }));
  await assert.rejects(refreshSession({ apiKey: 'K', refreshToken: 'rt', fetch: f }), e => e.code === 'reauth');
});

function cacheFor(handlers = {}) {
  const clock = { t: 1_000_000 };
  const saved = new Map();
  const tokenCalls = [];
  const f = fakeFetch((url, body) => {
    if (url.includes('securetoken')) return handlers.refresh ? handlers.refresh(body) : reply(200, { id_token: 'refreshed', refresh_token: 'rt2', user_id: 'ua', expires_in: '3600' });
    const acct = JSON.parse(body).postBody.match(/access_token=tok-(\w+)/)[1];
    return idpOk(acct);
  });
  const cache = new SessionCache({
    apiKey: 'K', fetch: f, now: () => clock.t,
    getAccessToken: async acct => { tokenCalls.push(acct); return acct === 'none' ? null : { provider: 'GitHub', token: `tok-${acct}` }; },
    loadRefresh: acct => saved.get(acct) || null,
    saveRefresh: (acct, rt) => { if (handlers.persist) saved.set(acct, rt); },
  });
  return { cache, clock, f, saved, tokenCalls };
}

test('SessionCache reuses a fresh session', async () => {
  const { cache, f } = cacheFor();
  const a = await cache.get('a');
  const b = await cache.get('a');
  assert.equal(a, b);
  assert.equal(f.calls.length, 1);
});

test('SessionCache refreshes 5 minutes before expiry', async () => {
  const { cache, clock, f } = cacheFor();
  const s = await cache.get('a');
  clock.t = s.expiresAt - 299_000;
  const s2 = await cache.get('a');
  const refreshes = f.calls.filter(c => c.url.includes('securetoken'));
  assert.equal(refreshes.length, 1);
  assert.equal(s2.idToken, 'refreshed');
  // 301 s before expiry is still fine.
  const { cache: c2, clock: k2, f: f2 } = cacheFor();
  const t = await c2.get('a');
  k2.t = t.expiresAt - 301_000;
  await c2.get('a');
  assert.equal(f2.calls.filter(c => c.url.includes('securetoken')).length, 0);
});

test('SessionCache switching account drops the old session', async () => {
  const { cache, tokenCalls } = cacheFor();
  const a = await cache.get('a');
  const b = await cache.get('b');
  assert.equal(a.uid, 'a');
  assert.equal(b.uid, 'b');
  assert.deepEqual(tokenCalls, ['a', 'b']);
  // Going back to a is a fresh sign-in, not the old session.
  const a2 = await cache.get('a');
  assert.notEqual(a2, a);
  assert.deepEqual(tokenCalls, ['a', 'b', 'a']);
});

test('SessionCache with no token is signed-out', async () => {
  const { cache } = cacheFor();
  await assert.rejects(cache.get('none'), e => e instanceof FriendsError && e.code === 'signed-out');
});

test('SessionCache tries a saved refresh token first, then falls back to a fresh sign-in', async () => {
  const { cache, saved, f, tokenCalls } = cacheFor({ persist: true, refresh: () => reply(400, { error: { message: 'INVALID_REFRESH_TOKEN' } }) });
  saved.set('a', 'old-rt');
  const s = await cache.get('a');
  assert.equal(f.calls[0].url.includes('securetoken'), true);
  assert.equal(f.calls[1].url.includes('signInWithIdp'), true);
  assert.equal(s.uid, 'a');
  assert.deepEqual(tokenCalls, ['a']);
  assert.equal(saved.get('a'), 'rt-a'); // the new refresh token is kept for next launch
});

test('SessionCache uses a saved refresh token without touching the provider token', async () => {
  const { cache, saved, tokenCalls } = cacheFor({ persist: true });
  saved.set('a', 'old-rt');
  const s = await cache.get('a');
  assert.equal(s.idToken, 'refreshed');
  assert.deepEqual(tokenCalls, []);
  assert.equal(saved.get('a'), 'rt2');
});

test('SessionCache drop() forgets the session', async () => {
  const { cache, tokenCalls } = cacheFor();
  await cache.get('a');
  cache.drop();
  await cache.get('a');
  assert.deepEqual(tokenCalls, ['a', 'a']);
});

test('SessionCache does not keep a session that was dropped while it was signing in', async () => {
  const { cache, tokenCalls } = cacheFor();
  const pending = cache.get('a');
  cache.drop();
  await pending;
  await cache.get('a');
  assert.deepEqual(tokenCalls, ['a', 'a']);
});
