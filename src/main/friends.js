// Friends: see what your friends are building, without ever sharing code.
// Everything goes to Firebase over plain fetch (no SDK): Firebase Auth turns the GitHub/Google sign-in into a Firebase
// identity, and Cloud Firestore keeps four things, all keyed by the verified email of the signed-in account:
//   users/{uid}                  who you are (email, name, avatar)
//   presence/{uid}               what you are doing now: state, project folder name, activity
//   requests/{fromUid}_{hash}    a friend request; hash = sha256 of the other person's email, so a repeat send is idempotent
//   friends/{uid}/list/{fid}     the accepted friends of one user
// Friends never sees file names, code, prompts or paths: `project` is a folder name (80 chars at most) or null.
// Every network call takes an injected `fetch`, so tests never touch the network.
const crypto = require('node:crypto');

const COPY = {
  'not-configured': "Friends isn't set up in this build.",
  'signed-out': 'Sign in with GitHub or Google to add friends.',
  reauth: 'Sign in again to use Friends.',
  'invalid-email': "That doesn't look like an email address.",
  self: "That's you.",
  exists: "You're already friends.",
  'too-many': 'Too many requests are still waiting. Cancel a few first.',
  gone: 'That request is no longer there.',
  network: "Couldn't reach Friends. Retrying…",
};

// code is one of: not-configured, signed-out, reauth, invalid-email, self, exists, too-many, gone, network.
// `message` is optional; each code has a default line.
class FriendsError extends Error {
  constructor(code, message) { super(message || COPY[code] || code); this.code = code; }
}

const sha256hex = s => crypto.createHash('sha256').update(String(s)).digest('hex');

// Trimmed, lowercased email, or null when it does not look like one.
function normEmail(s) {
  if (typeof s !== 'string') return null;
  const e = s.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

// Put in a field to have Firestore stamp it with its own clock when the write lands.
const SERVER_TIME = Symbol('SERVER_TIME');

function toValue(v) {
  if (v === null) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  switch (typeof v) {
    case 'string': return { stringValue: v };
    case 'boolean': return { booleanValue: v };
    case 'number': return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    case 'object':
      if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
      return { mapValue: { fields: toFields(v, true) } };
    default: throw new TypeError(`Cannot store a ${typeof v} in Firestore`);
  }
}

// Plain JSON -> Firestore `fields`. undefined and top-level SERVER_TIME fields are left out (see transformsOf).
function toFields(obj, nested = false) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (v === SERVER_TIME) {
      if (nested) throw new TypeError('SERVER_TIME only works on top-level fields');
      continue;
    }
    out[k] = toValue(v);
  }
  return out;
}

// The REQUEST_TIME field transforms for every SERVER_TIME field in obj.
const transformsOf = obj => Object.entries(obj)
  .filter(([, v]) => v === SERVER_TIME)
  .map(([fieldPath]) => ({ fieldPath, setToServerValue: 'REQUEST_TIME' }));

function fromValue(v) {
  if (!v || typeof v !== 'object') return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return Date.parse(v.timestampValue);
  if ('mapValue' in v) return fromFields(v.mapValue.fields);
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue);
  if ('referenceValue' in v) return v.referenceValue;
  return null;
}

function fromFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = fromValue(v);
  return out;
}

// A Firestore document -> { id, ...plain fields }. id is the last segment of the document path.
function fromDoc(doc) {
  return { id: String(doc.name || '').split('/').pop(), ...fromFields(doc.fields) };
}

// ---- Firebase session ----

const IDP_URL = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp';
const REFRESH_URL = 'https://securetoken.googleapis.com/v1/token';
const REFRESH_EARLY_MS = 5 * 60 * 1000;
const PROVIDER_IDS = { GitHub: 'github.com', Google: 'google.com' };
const reauthError = provider => new FriendsError('reauth', provider ? `Sign in to ${provider} again to use Friends.` : undefined);

// POSTs and returns the parsed JSON, or throws a FriendsError. `onFail(message)` may return a FriendsError for a 4xx.
async function postJson(fetchFn, url, init, onFail) {
  let res;
  try { res = await fetchFn(url, { method: 'POST', ...init }); }
  catch { throw new FriendsError('network'); }
  const body = await res.json().catch(() => ({}));
  if (res.ok) return body;
  const msg = String(body && body.error && body.error.message || '');
  if (res.status === 429 || res.status >= 500) throw new FriendsError('network');
  throw onFail(msg) || new FriendsError('network', `Friends sign-in failed (${res.status}).`);
}

// The email claim of a Firebase id token (a JWT), or null. Only read, never trusted for anything but display and matching.
function emailFromIdToken(jwt) {
  try {
    const claims = JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString('utf8'));
    return normEmail(claims.email);
  } catch { return null; }
}

// Exchanges a GitHub or Google access token for a Firebase session.
async function firebaseSession({ apiKey, provider, accessToken, fetch: fetchFn = globalThis.fetch, now = Date.now }) {
  const providerId = PROVIDER_IDS[provider];
  if (!providerId) throw new FriendsError('reauth');
  const body = await postJson(fetchFn, `${IDP_URL}?key=${encodeURIComponent(apiKey)}`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      postBody: `access_token=${encodeURIComponent(accessToken)}&providerId=${providerId}`,
      requestUri: 'http://localhost',
      returnIdpCredential: true,
      returnSecureToken: true,
    }),
  }, msg => {
    if (/OPERATION_NOT_ALLOWED|API key not valid|API_KEY|PROJECT_NOT_FOUND/i.test(msg)) return new FriendsError('not-configured');
    return reauthError(provider);
  });
  return {
    uid: body.localId,
    idToken: body.idToken,
    refreshToken: body.refreshToken,
    email: normEmail(body.email),
    expiresAt: now() + Number(body.expiresIn || 3600) * 1000,
  };
}

// Trades a saved refresh token for a new session. The refresh reply has no email, so it is read from the id token
// (or kept from `email`, which the caller may pass from the session it is replacing).
async function refreshSession({ apiKey, refreshToken, email = null, fetch: fetchFn = globalThis.fetch, now = Date.now }) {
  const body = await postJson(fetchFn, `${REFRESH_URL}?key=${encodeURIComponent(apiKey)}`, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
  }, () => reauthError());
  return {
    uid: body.user_id,
    idToken: body.id_token,
    refreshToken: body.refresh_token || refreshToken,
    email: emailFromIdToken(body.id_token) || email,
    expiresAt: now() + Number(body.expires_in || 3600) * 1000,
  };
}

// One Firebase session at a time, for the account that is active right now. Asking for another account throws the old
// session away, so presence and friends are never written or read as the previous account.
class SessionCache {
  constructor({ apiKey, fetch: fetchFn = globalThis.fetch, now = Date.now, getAccessToken, loadRefresh = () => null, saveRefresh = () => {} }) {
    Object.assign(this, { apiKey, fetchFn, now, getAccessToken, loadRefresh, saveRefresh });
    this.acct = null;
    this.session = null;
    this.pending = null;
    this.gen = 0; // bumped by drop(), so a sign-in that finishes after a drop is not kept
  }
  drop() { this.gen++; this.acct = null; this.session = null; this.pending = null; }

  async get(acct) {
    if (this.acct !== acct) this.drop();
    this.acct = acct;
    if (this.session && this.session.expiresAt - this.now() >= REFRESH_EARLY_MS) return this.session;
    if (this.pending) return this.pending;
    const gen = this.gen;
    const p = this.load(acct, this.session).then(s => {
      if (gen === this.gen) this.session = s;
      return s;
    }).finally(() => { if (this.pending === p) this.pending = null; });
    this.pending = p;
    return p;
  }

  async load(acct, previous) {
    const refreshToken = previous ? previous.refreshToken : await this.loadRefresh(acct);
    if (refreshToken) {
      try {
        const s = await refreshSession({ apiKey: this.apiKey, refreshToken, email: previous && previous.email, fetch: this.fetchFn, now: this.now });
        await this.saveRefresh(acct, s.refreshToken);
        return s;
      } catch (e) {
        if (!(e instanceof FriendsError) || e.code !== 'reauth') throw e;
        // The refresh token is dead; sign in again with the account's own token below.
      }
    }
    const tok = await this.getAccessToken(acct);
    if (!tok || !tok.token) throw new FriendsError('signed-out');
    const s = await firebaseSession({ apiKey: this.apiKey, provider: tok.provider, accessToken: tok.token, fetch: this.fetchFn, now: this.now });
    await this.saveRefresh(acct, s.refreshToken);
    return s;
  }
}

module.exports = { FriendsError, firebaseSession, refreshSession, SessionCache, SERVER_TIME, toFields, transformsOf, fromDoc, normEmail, sha256hex };
