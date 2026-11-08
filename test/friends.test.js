const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { callWithRetry, friendsReply, toFields, fromDoc, normEmail, sha256hex, FriendsError, clipName, safeAvatar } = require('../src/main/friends');

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

test('normEmail refuses an address longer than 254 characters', () => {
  const at254 = `${'a'.repeat(64)}@${'b'.repeat(185)}.com`;
  assert.equal(at254.length, 254);
  assert.equal(normEmail(at254), at254);
  assert.equal(normEmail(`a${at254}`), null);
});

test('clipName keeps names to 80 characters without splitting an emoji; safeAvatar drops a URL over 2048', () => {
  assert.equal(clipName('x'.repeat(100)), 'x'.repeat(80));
  assert.equal(clipName('Bob'), 'Bob');
  const emoji = `${'x'.repeat(79)}😀`; // 81 UTF-16 units; the cut would land inside the emoji
  assert.equal(clipName(emoji), 'x'.repeat(79));
  assert.equal(clipName(''), null);
  assert.equal(clipName(null), null);
  const url = `https://a/${'p'.repeat(2038)}`;
  assert.equal(url.length, 2048);
  assert.equal(safeAvatar(url), url);
  assert.equal(safeAvatar(`${url}p`), null);
  assert.equal(safeAvatar(''), null);
  assert.equal(safeAvatar(42), null);
});

test('safeAvatar keeps only http(s) URLs', () => {
  assert.equal(safeAvatar('https://avatars.githubusercontent.com/u/1'), 'https://avatars.githubusercontent.com/u/1');
  assert.equal(safeAvatar('http://example.com/a.png'), 'http://example.com/a.png');
  assert.equal(safeAvatar('HTTPS://example.com/a.png'), 'HTTPS://example.com/a.png');
  assert.equal(safeAvatar('javascript:alert(1)'), null);
  assert.equal(safeAvatar('JavaScript:alert(1)'), null);
  assert.equal(safeAvatar('data:image/png;base64,AAAA'), null);
  assert.equal(safeAvatar('file:///C:/Windows/win.ini'), null);
  assert.equal(safeAvatar(' https://example.com/a.png'), null);
  assert.equal(safeAvatar('https://'), null);
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
const idpOk = (uid, extra = {}) => reply(200, { localId: uid, idToken: `id-${uid}`, refreshToken: `rt-${uid}`, email: `${uid}@x.com`, emailVerified: true, expiresIn: '3600', ...extra });

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

test('firebaseSession rejects an account whose email is not verified', async () => {
  for (const emailVerified of [false, undefined]) {
    const f = fakeFetch(() => idpOk('u1', { emailVerified }));
    await assert.rejects(firebaseSession({ apiKey: 'K', provider: 'GitHub', accessToken: 'T', fetch: f }),
      e => e instanceof FriendsError && e.code === 'unverified');
  }
});

test('firebaseSession does not ask for the provider credential back', async () => {
  const f = fakeFetch(() => idpOk('u1'));
  await firebaseSession({ apiKey: 'K', provider: 'GitHub', accessToken: 'T', fetch: f });
  assert.equal('returnIdpCredential' in JSON.parse(f.calls[0].body), false);
});

test('firebaseSession turns a 200 without a usable session into linked', async () => {
  const cases = [
    { idToken: undefined },
    { idToken: '' },
    { localId: undefined },
    { needConfirmation: true },
    { errorMessage: 'FEDERATED_USER_ID_ALREADY_LINKED' },
  ];
  for (const extra of cases) {
    const f = fakeFetch(() => idpOk('u1', extra));
    await assert.rejects(firebaseSession({ apiKey: 'K', provider: 'GitHub', accessToken: 'T', fetch: f }),
      e => e instanceof FriendsError && e.code === 'linked'
        && e.message === 'This email is already used by your other sign-in. Switch to that account to use Friends.',
      JSON.stringify(extra));
  }
  // needConfirmation without a token or a verified email is still linked, not unverified.
  const f = fakeFetch(() => reply(200, { needConfirmation: true, email: 'u1@x.com', emailVerified: false }));
  await assert.rejects(firebaseSession({ apiKey: 'K', provider: 'Google', accessToken: 'T', fetch: f }), e => e.code === 'linked');
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

test('SessionCache does not save the refresh token of a sign-in that was dropped while it ran', async () => {
  // A fresh sign-in (no saved refresh token) dropped mid-way: nothing is saved.
  const a = cacheFor({ persist: true });
  const pending = a.cache.get('a');
  a.cache.drop(); // e.g. sign-out, which has just cleared the saved token
  await pending;
  assert.equal(a.saved.has('a'), false);
  // The same through the refresh path: the old token stays as it was, the new one is not written.
  const b = cacheFor({ persist: true });
  b.saved.set('a', 'old-rt');
  const p2 = b.cache.get('a');
  b.cache.drop();
  await p2;
  assert.equal(b.saved.get('a'), 'old-rt');
  // Not dropped: saved as usual.
  const c = cacheFor({ persist: true });
  await c.cache.get('a');
  assert.equal(c.saved.get('a'), 'rt-a');
});

// ---- Task 3: Friends API over Firestore ----

const { friendsApi } = require('../src/main/friends');

const DOCS = 'projects/p1/databases/(default)/documents';
const BASE = `https://firestore.googleapis.com/v1/${DOCS}`;
const hashOf = e => sha256hex(e);
const pdoc = (path, obj) => ({ name: `${DOCS}/${path}`, fields: toFields(obj) });
const T = Date.UTC(2026, 10, 8, 12, 0, 0);
const iso = ms => new Date(ms).toISOString();

// A tiny Firestore: answers GET list / runQuery / batchGet from `data`, and records writes.
function fakeStore(data = {}) {
  const d = { friends: [], presence: {}, declined: [], incoming: [], outgoing: [], accepted: { incoming: [], outgoing: [] }, readTime: iso(T), ...data };
  const log = { commits: [], queries: [], all: [] };
  const handler = async (url, init) => {
    const method = init.method || 'GET';
    log.all.push({ method, url, init });
    if (method === 'GET' && url.startsWith(`${BASE}/friends/u1/list`)) return reply(200, d.friends.length ? { documents: d.friends } : {});
    if (method === 'GET' && url.startsWith(`${BASE}/presence/`)) {
      const uid = url.slice(`${BASE}/presence/`.length);
      if ((d.presenceDenied || []).includes(uid)) return reply(403, { error: { status: 'PERMISSION_DENIED' } });
      return d.presence[uid] ? reply(200, d.presence[uid]) : reply(404, { error: { status: 'NOT_FOUND' } });
    }
    if (method === 'GET' && url.startsWith(`${BASE}/requests/`)) {
      const id = url.slice(`${BASE}/requests/`.length);
      const hit = (d.requestDocs || []).find(x => x.name.endsWith(`/${id}`));
      if (d.requestStatus) return reply(d.requestStatus, { error: { status: 'x' } });
      return hit ? reply(200, hit) : reply(404, { error: { status: 'NOT_FOUND' } });
    }
    const body = init.body ? JSON.parse(init.body) : {};
    if (url === `${BASE}:commit`) {
      if (d.commitStatus) return reply(d.commitStatus, { error: { status: 'x' } });
      log.commits.push(body);
      return reply(200, { writeResults: [] });
    }
    if (url === `${BASE}:runQuery`) {
      log.queries.push(body);
      const filters = body.structuredQuery.where.compositeFilter.filters.map(f => [f.fieldFilter.field.fieldPath, f.fieldFilter.value.stringValue]);
      const has = (k, v) => filters.some(([fk, fv]) => fk === k && (v === undefined || fv === v));
      let docs = [];
      if (has('status', 'accepted')) {
        // Answered like Firestore would: only the accepted docs that match every filter.
        const fieldOf = (doc, k) => { const v = doc.fields[k]; return v && 'stringValue' in v ? v.stringValue : null; };
        docs = [...d.accepted.incoming, ...d.accepted.outgoing].filter(doc => filters.every(([k, v]) => fieldOf(doc, k) === v));
      }
      else docs = has('fromUid') ? d.outgoing : d.incoming;
      return reply(200, docs.length ? docs.map(document => ({ document, readTime: d.readTime })) : [{ readTime: d.readTime }]);
    }
    if (url === `${BASE}:batchGet`) {
      // Like Firestore: one unreadable document refuses the whole batch.
      if (body.documents.some(n => (d.presenceDenied || []).some(uid => n.endsWith(`/presence/${uid}`)))) return reply(403, { error: { status: 'PERMISSION_DENIED' } });
      return reply(200, body.documents.map(name => {
        if (name.includes('/declined/')) {
          const id = name.split('/').pop();
          return d.declined.includes(id) ? { found: pdoc(`friends/u1/declined/${id}`, { at: new Date(T - 5000) }), readTime: d.readTime } : { missing: name, readTime: d.readTime };
        }
        const uid = name.split('/').pop();
        return d.presence[uid] ? { found: d.presence[uid], readTime: d.readTime } : { missing: name, readTime: d.readTime };
      }));
    }
    return reply(500, { error: { message: `unexpected ${method} ${url}` } });
  };
  const f = async (url, init = {}) => handler(url, init);
  f.log = log; f.data = d;
  return f;
}
const SESSION = { uid: 'u1', idToken: 'IT', email: 'me@x.com' };
const apiFor = (f, over = {}) => friendsApi({ projectId: 'p1', session: SESSION, fetch: f, me: { name: 'Me', avatar: 'https://a/me.png' }, now: () => T, ...over });
const friendDoc = (uid, email, name = uid) => pdoc(`friends/u1/list/${uid}`, { email, name, avatar: null, since: new Date(T - 86400000) });
const reqDoc = (id, o) => pdoc(`requests/${id}`, { status: 'pending', createdAt: new Date(T - 1000), ...o });
const presenceDoc = (uid, o) => pdoc(`presence/${uid}`, { project: null, activity: 'idle', ...o });

test('sendRequest normalises the email and uses fromUid_sha256 as the id', async () => {
  const f = fakeStore();
  const r = await apiFor(f).sendRequest('  Bob@X.com ');
  const id = `u1_${hashOf('bob@x.com')}`;
  assert.deepEqual(r, { id });
  assert.equal(f.log.commits.length, 1);
  const w = f.log.commits[0].writes[0];
  assert.equal(f.log.commits[0].writes.length, 1);
  assert.equal(w.update.name, `${DOCS}/requests/${id}`);
  assert.deepEqual(w.currentDocument, { exists: false });
  assert.deepEqual(w.updateTransforms, [{ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' }]);
  const got = fromDoc({ name: w.update.name, fields: w.update.fields });
  assert.equal(got.toEmail, 'bob@x.com');
  assert.equal(got.fromUid, 'u1');
  assert.equal(got.fromEmail, 'me@x.com');
  assert.equal(got.fromName, 'Me');
  assert.equal(got.status, 'pending');
  assert.equal(got.toUid, null);
  assert.equal('createdAt' in got, false); // stamped by Firestore, not by this computer's clock
  assert.equal(f.log.all.find(c => c.url.endsWith(':commit')).init.headers.Authorization, 'Bearer IT');
});

test('long names are cut to 80 and over-long avatars dropped in every write the rules check', async () => {
  const longName = 'N'.repeat(120);
  const longAvatar = `https://a/${'p'.repeat(3000)}`;
  const reqId = `u2_${hashOf('me@x.com')}`;
  const f = fakeStore({ requestDocs: [reqDoc(reqId, { fromUid: 'u2', fromEmail: 'bob@x.com', fromName: longName, fromAvatar: longAvatar, toEmail: 'me@x.com', toUid: null })] });
  const api = apiFor(f, { me: { name: longName, avatar: longAvatar } });
  await api.sendRequest('bob@x.com');
  await api.upsertProfile();
  await api.accept(reqId);
  assert.equal(f.log.commits.length, 3); // send, profile, accept
  const fields = w => fromDoc({ name: w.update.name, fields: w.update.fields });
  const sent = fields(f.log.commits[0].writes[0]);
  assert.equal(sent.fromName, 'N'.repeat(80));
  assert.equal(sent.fromAvatar, null);
  const profile = fields(f.log.commits[1].writes[0]);
  assert.equal(profile.name, 'N'.repeat(80));
  assert.equal(profile.avatar, null);
  const lists = f.log.commits[2].writes.filter(w => w.update && w.update.name.includes('/friends/')).map(fields);
  assert.equal(lists.length, 2);
  for (const l of lists) { assert.equal(l.name, 'N'.repeat(80)); assert.equal(l.avatar, null); }
});

test('sendRequest rejects things that are not emails', async () => {
  const f = fakeStore();
  await assert.rejects(apiFor(f).sendRequest('bob'), e => e instanceof FriendsError && e.code === 'invalid-email');
  assert.equal(f.log.all.length, 0);
});

test('sendRequest to own email throws self', async () => {
  const f = fakeStore();
  await assert.rejects(apiFor(f).sendRequest(' ME@x.com '), e => e.code === 'self');
  assert.equal(f.log.all.length, 0);
});

test('sendRequest to an existing friend throws exists; repeat pending send writes nothing', async () => {
  const bobId = `u1_${hashOf('bob@x.com')}`;
  const f = fakeStore({ friends: [friendDoc('u2', 'bob@x.com', 'Bob')], outgoing: [reqDoc(bobId, { fromUid: 'u1', toEmail: 'cy@x.com' })] });
  const api = apiFor(f);
  await assert.rejects(api.sendRequest('Bob@x.com'), e => e.code === 'exists');
  assert.equal(f.log.commits.length, 0);
  // A pending request to cy is already out there: sending again resolves with the same id and writes nothing.
  const cyId = `u1_${hashOf('cy@x.com')}`;
  f.data.outgoing = [reqDoc(cyId, { fromUid: 'u1', toEmail: 'cy@x.com' })];
  assert.deepEqual(await api.sendRequest(' CY@x.com'), { id: cyId });
  assert.equal(f.log.commits.length, 0);
});

test('sendRequest treats a request that already exists server-side (409, or 403) as sent', async () => {
  for (const status of [409, 403]) {
    const f = fakeStore({ commitStatus: status });
    assert.deepEqual(await apiFor(f).sendRequest('dan@x.com'), { id: `u1_${hashOf('dan@x.com')}` });
  }
});

test('sendRequest throws too-many at 50 pending', async () => {
  const outgoing = Array.from({ length: 50 }, (_, i) => reqDoc(`u1_h${i}`, { fromUid: 'u1', toEmail: `p${i}@x.com` }));
  const f = fakeStore({ outgoing });
  const api = apiFor(f);
  await assert.rejects(api.sendRequest('new@x.com'), e => e.code === 'too-many');
  assert.equal(f.log.commits.length, 0);
  // 49 is fine.
  f.data.outgoing = outgoing.slice(0, 49);
  await api.sendRequest('new@x.com');
  assert.equal(f.log.commits.length, 1);
});

test('accept writes one commit with request, both list docs, the reverse-request delete and the decline-marker delete', async () => {
  const reqId = `u2_${hashOf('me@x.com')}`;
  const reverseId = `u1_${hashOf('bob@x.com')}`;
  const f = fakeStore({
    requestDocs: [reqDoc(reqId, { fromUid: 'u2', fromEmail: 'bob@x.com', fromName: 'Bob', fromAvatar: 'https://a/bob.png', toEmail: 'me@x.com', toUid: null })],
    outgoing: [reqDoc(reverseId, { fromUid: 'u1', toEmail: 'bob@x.com' })],
  });
  await apiFor(f).accept(reqId);
  assert.equal(f.log.commits.length, 1);
  const w = f.log.commits[0].writes;
  assert.equal(w.length, 5);
  assert.equal(w[0].update.name, `${DOCS}/requests/${reqId}`);
  assert.deepEqual(fromDoc({ name: w[0].update.name, fields: w[0].update.fields }), { id: reqId, status: 'accepted', toUid: 'u1' });
  assert.deepEqual(w[0].updateMask.fieldPaths, ['status', 'toUid']);
  assert.equal(w[1].update.name, `${DOCS}/friends/u1/list/u2`);
  assert.equal(fromDoc(w[1].update).email, 'bob@x.com');
  assert.equal(fromDoc(w[1].update).name, 'Bob');
  assert.deepEqual(w[1].updateTransforms, [{ fieldPath: 'since', setToServerValue: 'REQUEST_TIME' }]);
  assert.equal(w[2].update.name, `${DOCS}/friends/u2/list/u1`);
  assert.equal(fromDoc(w[2].update).email, 'me@x.com');
  assert.equal(fromDoc(w[2].update).name, 'Me');
  assert.deepEqual(w[3], { delete: `${DOCS}/requests/${reverseId}` });
  assert.deepEqual(w[4], { delete: `${DOCS}/friends/u1/declined/${reqId}` });
});

test('accept without a reverse request writes three docs and only the decline-marker delete', async () => {
  const reqId = `u2_${hashOf('me@x.com')}`;
  const f = fakeStore({ requestDocs: [reqDoc(reqId, { fromUid: 'u2', fromEmail: 'Bob@x.com', fromName: 'Bob', toEmail: 'me@x.com' })] });
  await apiFor(f).accept(reqId);
  const w = f.log.commits[0].writes;
  assert.equal(w.length, 4);
  assert.deepEqual(w.filter(x => x.delete).map(x => x.delete), [`${DOCS}/friends/u1/declined/${reqId}`]);
});

test('accept of a request that is gone (404, or 403 after the sender cancelled) throws gone, not reauth', async () => {
  const id = `u2_${hashOf('me@x.com')}`;
  for (const requestStatus of [undefined, 404, 403]) {
    const f = fakeStore({ requestStatus });
    await assert.rejects(apiFor(f).accept(id), e => e instanceof FriendsError && e.code === 'gone');
    assert.equal(f.log.commits.length, 0);
  }
});

test('decline leaves the request alone and writes only my private marker', async () => {
  const id = `u2_${hashOf('me@x.com')}`;
  const f = fakeStore({ requestDocs: [reqDoc(id, { fromUid: 'u2', fromEmail: 'bob@x.com', toEmail: 'me@x.com' })] });
  await apiFor(f).decline(id);
  assert.equal(f.log.commits.length, 1);
  const w = f.log.commits[0].writes;
  assert.equal(w.length, 1);
  assert.equal(w[0].update.name, `${DOCS}/friends/u1/declined/${id}`);
  assert.deepEqual(w[0].update.fields, {});
  assert.deepEqual(w[0].updateTransforms, [{ fieldPath: 'at', setToServerValue: 'REQUEST_TIME' }]);
  assert.equal(w[0].updateMask, undefined);
});

test('decline whose marker write is refused (403/404) throws gone', async () => {
  const id = `u2_${hashOf('me@x.com')}`;
  for (const commitStatus of [403, 404]) {
    const f = fakeStore({ commitStatus, requestDocs: [reqDoc(id, { fromUid: 'u2', fromEmail: 'bob@x.com', toEmail: 'me@x.com' })] });
    await assert.rejects(apiFor(f).decline(id), e => e.code === 'gone');
  }
});

test('list hides incoming requests I declined, with one batchGet of my markers', async () => {
  const a = `u5_${hashOf('me@x.com')}`, b = `u6_${hashOf('me@x.com')}`;
  const f = fakeStore({
    incoming: [reqDoc(a, { fromUid: 'u5', fromEmail: 'eve@x.com', toEmail: 'me@x.com' }), reqDoc(b, { fromUid: 'u6', fromEmail: 'dan@x.com', toEmail: 'me@x.com' })],
    declined: [a],
  });
  const out = await apiFor(f).list();
  assert.deepEqual(out.incoming.map(r => r.id), [b]);
  const gets = f.log.all.filter(c => c.url === `${BASE}:batchGet`);
  assert.equal(gets.length, 1);
  assert.deepEqual(JSON.parse(gets[0].init.body).documents, [`${DOCS}/friends/u1/declined/${a}`, `${DOCS}/friends/u1/declined/${b}`]);
});

test('list with no incoming requests reads no markers', async () => {
  const f = fakeStore();
  await apiFor(f).list();
  assert.equal(f.log.all.filter(c => c.url === `${BASE}:batchGet`).length, 0);
});

test('decline of a request that is no longer pending, or gone, throws gone and writes nothing', async () => {
  const id = `u2_${hashOf('me@x.com')}`;
  // An accepted request (a stale row in the UI) must not be marked declined.
  const accepted = fakeStore({ requestDocs: [reqDoc(id, { status: 'accepted', fromUid: 'u2', toEmail: 'me@x.com', toUid: 'u1' })] });
  await assert.rejects(apiFor(accepted).decline(id), e => e.code === 'gone');
  assert.equal(accepted.log.commits.length, 0);
  for (const requestStatus of [undefined, 404, 403]) {
    const f = fakeStore({ requestStatus });
    await assert.rejects(apiFor(f).decline(id), e => e.code === 'gone');
    assert.equal(f.log.commits.length, 0);
  }
});

test('cancel deletes my own request; a request already gone (403/404) is gone, not reauth', async () => {
  const f = fakeStore();
  const api = apiFor(f);
  const mine = `u1_${hashOf('bob@x.com')}`;
  await api.cancel(mine);
  assert.deepEqual(f.log.commits[0].writes, [{ delete: `${DOCS}/requests/${mine}` }]);
  // Cancel only touches requests I sent.
  await assert.rejects(api.cancel(`u2_${hashOf('me@x.com')}`), e => e.code === 'gone');
  await assert.rejects(api.cancel('../users/u2'), e => e.code === 'gone');
  for (const commitStatus of [403, 404]) {
    await assert.rejects(apiFor(fakeStore({ commitStatus })).cancel(mine), e => e instanceof FriendsError && e.code === 'gone');
  }
});

test('removeFriend deletes both list docs and the request in one commit', async () => {
  const sentByThem = `u2_${hashOf('me@x.com')}`;
  const f = fakeStore({
    accepted: {
      incoming: [reqDoc(sentByThem, { status: 'accepted', fromUid: 'u2', toEmail: 'me@x.com', toUid: 'u1' }), reqDoc(`u9_${hashOf('me@x.com')}`, { status: 'accepted', fromUid: 'u9', toEmail: 'me@x.com', toUid: 'u1' })],
      outgoing: [],
    },
  });
  await apiFor(f).removeFriend('u2');
  assert.equal(f.log.commits.length, 1);
  assert.deepEqual(f.log.commits[0].writes, [
    { delete: `${DOCS}/friends/u1/list/u2` },
    { delete: `${DOCS}/friends/u2/list/u1` },
    { delete: `${DOCS}/requests/${sentByThem}` },
  ]);
});

test('removeFriend asks for the accepted request pinned to both uids, in each direction', async () => {
  const f = fakeStore();
  await apiFor(f).removeFriend('u2');
  const shapes = f.log.queries.map(q => Object.fromEntries(q.structuredQuery.where.compositeFilter.filters.map(x => [x.fieldFilter.field.fieldPath, x.fieldFilter.value.stringValue])));
  assert.deepEqual(shapes, [
    { fromUid: 'u2', toUid: 'u1', status: 'accepted' },
    { fromUid: 'u1', toUid: 'u2', status: 'accepted' },
  ]);
  // Nothing found: the list docs still go.
  assert.deepEqual(f.log.commits[0].writes.map(w => w.delete), [`${DOCS}/friends/u1/list/u2`, `${DOCS}/friends/u2/list/u1`]);
});

test('removeFriend also finds the request when I sent it', async () => {
  const sentByMe = `u1_${hashOf('bob@x.com')}`;
  const f = fakeStore({ accepted: { incoming: [], outgoing: [reqDoc(sentByMe, { status: 'accepted', fromUid: 'u1', toEmail: 'bob@x.com', toUid: 'u2' })] } });
  await apiFor(f).removeFriend('u2');
  assert.deepEqual(f.log.commits[0].writes.map(w => w.delete), [`${DOCS}/friends/u1/list/u2`, `${DOCS}/friends/u2/list/u1`, `${DOCS}/requests/${sentByMe}`]);
});

test('list marks a friend with no presence doc offline', async () => {
  const f = fakeStore({ friends: [friendDoc('u2', 'bob@x.com', 'Bob')], presence: {} });
  const out = await apiFor(f).list();
  assert.equal(out.friends.length, 1);
  assert.deepEqual(out.friends[0], { uid: 'u2', email: 'bob@x.com', name: 'Bob', avatar: null, state: 'offline', project: null, activity: 'idle', updatedAt: null });
});

test('list reads presence for friends and keeps fresh online state', async () => {
  const f = fakeStore({
    friends: [friendDoc('u2', 'bob@x.com', 'Bob'), friendDoc('u3', 'cy@x.com', 'Cy')],
    presence: {
      u2: presenceDoc('u2', { state: 'online', project: 'my-app', activity: 'agent', updatedAt: new Date(T - 30000) }),
      u3: presenceDoc('u3', { state: 'away', project: null, activity: 'idle', updatedAt: new Date(T - 180000) }),
    },
  });
  const out = await apiFor(f).list();
  const bob = out.friends.find(x => x.uid === 'u2'), cy = out.friends.find(x => x.uid === 'u3');
  assert.deepEqual([bob.state, bob.project, bob.activity, bob.updatedAt], ['online', 'my-app', 'agent', T - 30000]);
  assert.equal(cy.state, 'away'); // exactly 180 s is not yet stale
  assert.equal(out.readTime, T);
  const batch = f.log.all.find(c => c.url === `${BASE}:batchGet`);
  assert.deepEqual(JSON.parse(batch.init.body).documents, [`${DOCS}/presence/u2`, `${DOCS}/presence/u3`]);
});

test('list marks presence older than 180s before readTime offline, using readTime not Date.now', async () => {
  const mk = ago => fakeStore({
    friends: [friendDoc('u2', 'bob@x.com', 'Bob')],
    presence: { u2: presenceDoc('u2', { state: 'online', project: 'my-app', activity: 'editing', updatedAt: new Date(T - ago) }) },
  });
  const realNow = Date.now;
  try {
    // A computer whose clock is ten days slow: old presence must still be offline.
    Date.now = () => T - 10 * 86400000;
    const stale = (await apiFor(mk(181000), { now: undefined }).list()).friends[0];
    assert.equal(stale.state, 'offline');
    assert.equal(stale.project, null);
    assert.equal(stale.activity, 'idle');
    assert.equal(stale.updatedAt, T - 181000);
    // A computer whose clock is ten days fast: fresh presence must still be online.
    Date.now = () => T + 10 * 86400000;
    const fresh = (await apiFor(mk(5000), { now: undefined }).list()).friends[0];
    assert.equal(fresh.state, 'online');
    assert.equal(fresh.project, 'my-app');
  } finally { Date.now = realNow; }
});

test('list still loads when a friend doc is one-sided: a refused presence batch is read one by one, refused = offline', async () => {
  const f = fakeStore({
    friends: [friendDoc('u2', 'bob@x.com', 'Bob'), friendDoc('u3', 'cy@x.com', 'Cy'), friendDoc('u4', 'di@x.com', 'Di')],
    presence: { u3: presenceDoc('u3', { state: 'online', project: 'my-app', activity: 'editing', updatedAt: new Date(T - 5000) }) },
    presenceDenied: ['u2'], // Bob's side of the friendship is gone, so his presence is unreadable
  });
  const out = await apiFor(f).list();
  const by = Object.fromEntries(out.friends.map(x => [x.uid, x]));
  assert.deepEqual([by.u2.state, by.u2.updatedAt], ['offline', null]);
  assert.deepEqual([by.u3.state, by.u3.project], ['online', 'my-app']);
  assert.deepEqual([by.u4.state, by.u4.updatedAt], ['offline', null]); // never shared: 404
  const gets = f.log.all.filter(c => c.method === 'GET' && c.url.includes('/presence/')).map(c => c.url.split('/').pop()).sort();
  assert.deepEqual(gets, ['u2', 'u3', 'u4']);
  // And Bob can still be removed.
  await apiFor(f).removeFriend('u2');
  assert.deepEqual(f.log.commits[0].writes.slice(0, 2).map(w => w.delete), [`${DOCS}/friends/u1/list/u2`, `${DOCS}/friends/u2/list/u1`]);
});

test('list does not fall back on a presence batch that fails for another reason', async () => {
  const f = fakeStore({ friends: [friendDoc('u2', 'bob@x.com', 'Bob')] });
  const g = async (url, init = {}) => (url === `${BASE}:batchGet` ? reply(401, { error: {} }) : f(url, init));
  await assert.rejects(apiFor(g).list(), e => e.code === 'reauth');
});

test('list drops a non-http(s) avatar on an incoming request', async () => {
  const f = fakeStore({
    incoming: [reqDoc(`u5_${hashOf('me@x.com')}`, { fromUid: 'u5', fromEmail: 'eve@x.com', fromName: 'Eve', fromAvatar: 'javascript:alert(1)', toEmail: 'me@x.com' })],
  });
  const out = await apiFor(f).list();
  assert.equal(out.incoming[0].avatar, null);
});

test('list returns incoming and outgoing requests', async () => {
  const f = fakeStore({
    incoming: [reqDoc(`u5_${hashOf('me@x.com')}`, { fromUid: 'u5', fromEmail: 'Eve@x.com', fromName: 'Eve', fromAvatar: 'https://a/eve.png', toEmail: 'me@x.com' })],
    outgoing: [reqDoc(`u1_${hashOf('zed@x.com')}`, { fromUid: 'u1', toEmail: 'zed@x.com' })],
  });
  const out = await apiFor(f).list();
  assert.deepEqual(out.incoming, [{ id: `u5_${hashOf('me@x.com')}`, email: 'eve@x.com', name: 'Eve', avatar: 'https://a/eve.png', createdAt: T - 1000 }]);
  assert.deepEqual(out.outgoing, [{ id: `u1_${hashOf('zed@x.com')}`, email: 'zed@x.com', name: null, avatar: null, createdAt: T - 1000 }]);
  assert.deepEqual(out.friends, []);
  // Requests are asked for as "mine and still pending".
  const asked = f.log.queries.map(q => q.structuredQuery.where.compositeFilter.filters.map(x => `${x.fieldFilter.field.fieldPath}=${x.fieldFilter.value.stringValue}`).sort().join('&')).sort();
  assert.deepEqual(asked, ['fromUid=u1&status=pending', 'status=pending&toEmail=me@x.com']);
});

test('writePresence truncates project to 80 chars and uses REQUEST_TIME', async () => {
  const f = fakeStore();
  await apiFor(f).writePresence({ state: 'online', project: 'x'.repeat(200), activity: 'editing' });
  const w = f.log.commits[0].writes[0];
  assert.equal(w.update.name, `${DOCS}/presence/u1`);
  const got = fromDoc(w.update);
  assert.equal(got.project.length, 80);
  assert.equal(got.state, 'online');
  assert.equal(got.activity, 'editing');
  assert.equal('updatedAt' in got, false);
  assert.deepEqual(w.updateTransforms, [{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }]);
  await apiFor(f).writePresence({ state: 'offline', project: null, activity: 'idle' });
  assert.equal(fromDoc(f.log.commits[1].writes[0].update).project, null);
});

test('upsertProfile writes users/{uid} with the verified email', async () => {
  const f = fakeStore();
  await apiFor(f).upsertProfile();
  const w = f.log.commits[0].writes[0];
  assert.equal(w.update.name, `${DOCS}/users/u1`);
  assert.deepEqual(fromDoc(w.update), { id: 'u1', email: 'me@x.com', name: 'Me', avatar: 'https://a/me.png' });
  assert.deepEqual(w.updateTransforms, [{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }]);
});

test('only a 401 from Firestore is reauth; a 403 is denied; a 503 or a dead network is network', async () => {
  const status = s => async () => reply(s, { error: { message: 'x' } });
  await assert.rejects(apiFor(status(401)).list(), e => e.code === 'reauth');
  await assert.rejects(apiFor(status(403)).writePresence({ state: 'online', project: null, activity: 'idle' }), e => e instanceof FriendsError && e.code === 'denied');
  await assert.rejects(apiFor(status(503)).list(), e => e.code === 'network');
  await assert.rejects(apiFor(async () => { throw new Error('offline'); }).list(), e => e.code === 'network');
});


// ---- Task 4: Presence throttle ----

const { presenceThrottle } = require('../src/main/friends');

const flush = () => new Promise(r => setImmediate(r));
// Fake time: timers only fire when advance() reaches them.
function fakeClock() {
  let t = 0, seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: t + ms }); return id; },
    clearTimer: id => { timers.delete(id); },
    pending: () => timers.size,
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        t = Math.max(t, next[1].at);
        timers.delete(next[0]);
        next[1].fn();
        await flush();
      }
      t = end;
      await flush();
    },
  };
}
const P = (state, project = null, activity = 'idle') => ({ state, project, activity });
function throttleFor(over = {}) {
  const clock = fakeClock();
  const writes = [];
  const th = presenceThrottle({ write: async p => { writes.push(p); if (over.fail) throw new Error('down'); }, ...clock, ...over });
  return { th, clock, writes };
}

test('first set writes at once', async () => {
  const { th, writes } = throttleFor();
  th.set(P('online', 'app', 'editing'));
  await flush();
  assert.deepEqual(writes, [P('online', 'app', 'editing')]);
});

test('changes within 10s coalesce into one write of the latest state', async () => {
  const { th, clock, writes } = throttleFor();
  th.set(P('online', 'a', 'editing'));
  await clock.advance(2000);
  th.set(P('online', 'b', 'agent'));
  await clock.advance(3000);
  th.set(P('away', 'b', 'idle'));
  assert.equal(writes.length, 1);
  await clock.advance(4999);
  assert.equal(writes.length, 1);
  await clock.advance(1);
  assert.deepEqual(writes, [P('online', 'a', 'editing'), P('away', 'b', 'idle')]);
});

test('a change after the gap has passed writes straight away', async () => {
  const { th, clock, writes } = throttleFor();
  th.set(P('online'));
  await clock.advance(10_000);
  th.set(P('away'));
  await flush();
  assert.deepEqual(writes, [P('online'), P('away')]);
});

test('setting the same state again does not write until the heartbeat', async () => {
  const { th, clock, writes } = throttleFor();
  th.set(P('online', 'a', 'editing'));
  await clock.advance(20_000);
  th.set(P('online', 'a', 'editing'));
  await flush();
  assert.equal(writes.length, 1);
  await clock.advance(40_000);
  assert.equal(writes.length, 2);
});

test('heartbeat rewrites the same state every 60s', async () => {
  const { th, clock, writes } = throttleFor();
  th.set(P('online', 'a', 'debug'));
  await clock.advance(59_999);
  assert.equal(writes.length, 1);
  await clock.advance(1);
  assert.equal(writes.length, 2);
  await clock.advance(60_000);
  assert.equal(writes.length, 3);
  assert.deepEqual(writes[2], P('online', 'a', 'debug'));
});

test('a failed write is dropped and retried at the next heartbeat', async () => {
  let down = true;
  const clock = fakeClock();
  const writes = [];
  const th = presenceThrottle({ write: async p => { writes.push(p); if (down) throw new Error('down'); }, ...clock });
  th.set(P('online', 'a', 'editing'));
  await clock.advance(30_000);
  assert.equal(writes.length, 1); // no retry loop
  down = false;
  await clock.advance(30_000);
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1], P('online', 'a', 'editing'));
});

test('a write that throws synchronously is also dropped', async () => {
  const clock = fakeClock();
  let n = 0;
  const th = presenceThrottle({ write: () => { n++; throw new Error('boom'); }, ...clock });
  th.set(P('online'));
  await clock.advance(60_000);
  assert.equal(n, 2);
});

test('after a failed write the same state is tried again on the next set', async () => {
  let down = true;
  const clock = fakeClock();
  const writes = [];
  const th = presenceThrottle({ write: async p => { writes.push(p); if (down) throw new Error('down'); }, ...clock });
  th.set(P('online'));
  await clock.advance(10_000);
  down = false;
  th.set(P('online'));
  await flush();
  assert.equal(writes.length, 2);
});

test('stop writes offline once and further sets do nothing', async () => {
  const { th, clock, writes } = throttleFor();
  th.set(P('online', 'a', 'editing'));
  await clock.advance(1000);
  await th.stop();
  assert.deepEqual(writes, [P('online', 'a', 'editing'), P('offline', null, 'idle')]);
  await th.stop();
  th.set(P('online', 'z', 'agent'));
  await clock.advance(120_000);
  assert.equal(writes.length, 2);
  assert.equal(clock.pending(), 0);
});

test('stop gives up on a stuck offline write after 1.5s', async () => {
  const clock = fakeClock();
  let calls = 0;
  const th = presenceThrottle({ write: () => (++calls === 1 ? Promise.resolve() : new Promise(() => {})), ...clock });
  th.set(P('online'));
  await flush();
  let done = false;
  const p = th.stop().then(() => { done = true; });
  await clock.advance(1499);
  assert.equal(done, false);
  await clock.advance(1);
  await p;
  assert.equal(done, true);
  assert.equal(calls, 2);
  assert.equal(clock.pending(), 0);
});

test('stop before anything was shared writes nothing', async () => {
  const { th, writes } = throttleFor();
  await th.stop();
  assert.deepEqual(writes, []);
});

// ---- Task 6: main-process helpers ----

test('callWithRetry renews and retries once on reauth only', async () => {
  let runs = 0, renews = 0;
  const out = await callWithRetry(async () => { if (++runs === 1) throw new FriendsError('reauth'); return 'ok'; }, async () => { renews++; });
  assert.deepEqual([out, runs, renews], ['ok', 2, 1]);

  runs = 0; renews = 0;
  await assert.rejects(callWithRetry(async () => { runs++; throw new FriendsError('reauth'); }, async () => { renews++; }), { code: 'reauth' });
  assert.deepEqual([runs, renews], [2, 1]); // a second reauth is final

  for (const code of ['denied', 'network', 'gone']) {
    runs = 0; renews = 0;
    await assert.rejects(callWithRetry(async () => { runs++; throw new FriendsError(code); }, async () => { renews++; }), { code });
    assert.deepEqual([runs, renews], [1, 0]);
  }
  await assert.rejects(callWithRetry(async () => { throw new TypeError('bug'); }, async () => {}), TypeError);
});

test('friendsReply names the provider for reauth and leaves other copy alone', () => {
  assert.deepEqual(friendsReply(new FriendsError('reauth'), 'GitHub'), { error: 'Sign in to GitHub again to use Friends.', code: 'reauth' });
  assert.deepEqual(friendsReply(new FriendsError('reauth', 'Sign in to Google again to use Friends.'), 'Google'), { error: 'Sign in to Google again to use Friends.', code: 'reauth' });
  assert.deepEqual(friendsReply(new FriendsError('reauth'), null), { error: 'Sign in again to use Friends.', code: 'reauth' });
  assert.deepEqual(friendsReply(new FriendsError('denied'), 'GitHub'), { error: "Friends can't do that.", code: 'denied' });
  assert.equal(friendsReply(new Error('x'), 'GitHub'), null);
});
