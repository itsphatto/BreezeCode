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

// ---- Friends API over Firestore ----

const MAX_PENDING_OUT = 50;
const STALE_MS = 180 * 1000; // presence older than this (by Firestore's clock) counts as offline
const PROJECT_MAX = 80;
const STATES = new Set(['online', 'away', 'offline']);
const ACTIVITIES = new Set(['editing', 'agent', 'debug', 'space', 'idle']);
const ID_OK = /^[A-Za-z0-9_-]{1,200}$/;

// Cuts a folder name to 80 characters without leaving half an emoji at the end.
function clipProject(p) {
  if (typeof p !== 'string' || !p) return null;
  let s = p.slice(0, PROJECT_MAX);
  if (/[\uD800-\uDBFF]$/.test(s)) s = s.slice(0, -1);
  return s;
}

// Everything the signed-in user can do with friends. `session` is { uid, idToken, email } from SessionCache; the caller
// gets a new api whenever the session changes. A 401/403 throws reauth; main refreshes the session and retries once.
function friendsApi({ projectId, session, fetch: fetchFn = globalThis.fetch, me = {}, now = Date.now }) {
  const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  const docName = p => `projects/${projectId}/databases/(default)/documents/${p}`;
  const myUid = session.uid;
  const myEmail = session.email;
  const myName = me.name || myEmail;
  const myAvatar = me.avatar || null;
  const safe = id => { if (typeof id !== 'string' || !ID_OK.test(id)) throw new FriendsError('gone'); return id; };
  const needEmail = () => { if (!myEmail) throw new FriendsError('reauth'); };

  async function call(method, url, body, allow = []) {
    let res;
    try {
      res = await fetchFn(url, {
        method,
        headers: { Authorization: `Bearer ${session.idToken}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch { throw new FriendsError('network'); }
    const data = await res.json().catch(() => ({}));
    if (res.ok || allow.includes(res.status)) return { status: res.status, data };
    if (res.status === 401 || res.status === 403) throw new FriendsError('reauth');
    const why = data && data.error && data.error.message;
    throw new FriendsError('network', why ? `Friends: ${why}` : undefined);
  }

  const commit = async writes => { await call('POST', `${base}:commit`, { writes }); };
  // A write of a whole document. SERVER_TIME fields become REQUEST_TIME transforms.
  const put = (path, obj, { mask, mustExist } = {}) => {
    const w = { update: { name: docName(path), fields: toFields(obj) } };
    const tf = transformsOf(obj);
    if (tf.length) w.updateTransforms = tf;
    if (mask) w.updateMask = { fieldPaths: mask };
    if (mustExist) w.currentDocument = { exists: true };
    return w;
  };
  const del = path => ({ delete: docName(path) });

  // Requests where every field in `filters` equals its value. Returns { docs, readTime }.
  async function queryRequests(filters, limit = 200) {
    const { data } = await call('POST', `${base}:runQuery`, {
      structuredQuery: {
        from: [{ collectionId: 'requests' }],
        where: { compositeFilter: { op: 'AND', filters: Object.entries(filters).map(([k, v]) => ({ fieldFilter: { field: { fieldPath: k }, op: 'EQUAL', value: toValue(v) } })) } },
        limit,
      },
    });
    const rows = Array.isArray(data) ? data : [];
    return { docs: rows.filter(r => r.document).map(r => fromDoc(r.document)), readTime: maxTime(rows) };
  }
  const maxTime = rows => rows.reduce((m, r) => Math.max(m, r.readTime ? Date.parse(r.readTime) : 0), 0);

  // The friends/{me}/list documents, all pages.
  async function friendDocs() {
    const out = [];
    let token = '';
    for (let page = 0; page < 20; page++) {
      const { data } = await call('GET', `${base}/friends/${myUid}/list?pageSize=300${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`, undefined, [404]);
      for (const d of data.documents || []) out.push(fromDoc(d));
      token = data.nextPageToken;
      if (!token) break;
    }
    return out;
  }

  const asReq = (r, who) => (who === 'from'
    ? { id: r.id, email: normEmail(r.fromEmail) || String(r.fromEmail || ''), name: r.fromName || null, avatar: r.fromAvatar || null, createdAt: r.createdAt ?? null }
    : { id: r.id, email: String(r.toEmail || ''), name: null, avatar: null, createdAt: r.createdAt ?? null });

  return {
    async upsertProfile() {
      needEmail();
      await commit([put(`users/${myUid}`, { email: myEmail, name: myName, avatar: myAvatar, updatedAt: SERVER_TIME })]);
    },

    async sendRequest(rawEmail) {
      const email = normEmail(rawEmail);
      if (!email) throw new FriendsError('invalid-email');
      needEmail();
      if (email === myEmail) throw new FriendsError('self');
      const id = `${myUid}_${sha256hex(email)}`;
      const [friends, pending] = await Promise.all([friendDocs(), queryRequests({ fromUid: myUid, status: 'pending' }, MAX_PENDING_OUT + 1)]);
      if (friends.some(f => normEmail(f.email) === email)) throw new FriendsError('exists');
      if (pending.docs.some(r => r.id === id)) return { id };
      if (pending.docs.length >= MAX_PENDING_OUT) throw new FriendsError('too-many');
      const fields = toFields({
        fromUid: myUid, fromEmail: myEmail, fromName: myName, fromAvatar: myAvatar,
        toEmail: email, toUid: null, status: 'pending', createdAt: new Date(now()),
      });
      // exists=false: if the request is already there (declined, or a race), it stays as it is and counts as sent.
      await call('PATCH', `${base}/requests/${id}?currentDocument.exists=false`, { fields }, [409]);
      return { id };
    },

    async accept(requestId) {
      needEmail();
      const id = safe(requestId);
      const { status, data } = await call('GET', `${base}/requests/${id}`, undefined, [404]);
      if (status === 404) throw new FriendsError('gone');
      const req = fromDoc(data);
      const theirEmail = normEmail(req.fromEmail);
      if (req.status !== 'pending' || req.toEmail !== myEmail || !theirEmail || !req.fromUid) throw new FriendsError('gone');
      const them = safe(req.fromUid);
      const writes = [
        put(`requests/${id}`, { status: 'accepted', toUid: myUid }, { mask: ['status', 'toUid'], mustExist: true }),
        put(`friends/${myUid}/list/${them}`, { email: theirEmail, name: req.fromName || theirEmail, avatar: req.fromAvatar || null, since: SERVER_TIME }),
        put(`friends/${them}/list/${myUid}`, { email: myEmail, name: myName, avatar: myAvatar, since: SERVER_TIME }),
      ];
      // If I had also asked them, that request is now pointless; a sender may always delete their own.
      const reverseId = `${myUid}_${sha256hex(theirEmail)}`;
      const mine = await queryRequests({ fromUid: myUid, status: 'pending' }, MAX_PENDING_OUT + 1);
      if (mine.docs.some(r => r.id === reverseId)) writes.push(del(`requests/${reverseId}`));
      await commit(writes);
    },

    async decline(requestId) {
      const id = safe(requestId);
      await commit([put(`requests/${id}`, { status: 'declined', toUid: myUid }, { mask: ['status', 'toUid'], mustExist: true })]);
    },

    async cancel(requestId) {
      const id = safe(requestId);
      if (!id.startsWith(`${myUid}_`)) throw new FriendsError('gone');
      await commit([del(`requests/${id}`)]);
    },

    async removeFriend(uid) {
      needEmail();
      const them = safe(uid);
      // The accepted request lives under whoever sent it: ask for both directions.
      const [theirs, mine] = await Promise.all([
        queryRequests({ toEmail: myEmail, status: 'accepted' }),
        queryRequests({ fromUid: myUid, status: 'accepted' }),
      ]);
      const ids = [...new Set([
        ...theirs.docs.filter(r => r.fromUid === them).map(r => r.id),
        ...mine.docs.filter(r => r.toUid === them).map(r => r.id),
      ])];
      await commit([del(`friends/${myUid}/list/${them}`), del(`friends/${them}/list/${myUid}`), ...ids.map(id => del(`requests/${id}`))]);
    },

    async writePresence({ state, project, activity }) {
      await commit([put(`presence/${myUid}`, {
        state: STATES.has(state) ? state : 'offline',
        project: clipProject(project),
        activity: ACTIVITIES.has(activity) ? activity : 'idle',
        updatedAt: SERVER_TIME,
      })]);
    },

    async list() {
      needEmail();
      const [friends, incoming, outgoing] = await Promise.all([
        friendDocs(),
        queryRequests({ toEmail: myEmail, status: 'pending' }),
        queryRequests({ fromUid: myUid, status: 'pending' }),
      ]);
      // Presence is batch-read; a friend who never shared has no doc, which is "offline", not an error.
      const presence = new Map();
      let readTime = Math.max(incoming.readTime, outgoing.readTime);
      for (let i = 0; i < friends.length; i += 100) {
        const names = friends.slice(i, i + 100).map(f => docName(`presence/${safe(f.id)}`));
        const { data } = await call('POST', `${base}:batchGet`, { documents: names });
        const rows = Array.isArray(data) ? data : [];
        readTime = Math.max(readTime, maxTime(rows));
        for (const r of rows) if (r.found) { const p = fromDoc(r.found); presence.set(p.id, p); }
      }
      // Staleness is judged against Firestore's own clock, so a wrong clock on this computer cannot skew it.
      if (!readTime) readTime = now();
      return {
        friends: friends.map(f => {
          const p = presence.get(f.id);
          const updatedAt = p && Number.isFinite(p.updatedAt) ? p.updatedAt : null;
          const live = p && STATES.has(p.state) && p.state !== 'offline' && updatedAt !== null && readTime - updatedAt <= STALE_MS;
          return {
            uid: f.id, email: f.email, name: f.name || f.email, avatar: f.avatar || null,
            state: live ? p.state : 'offline',
            project: live ? clipProject(p.project) : null,
            activity: live && ACTIVITIES.has(p.activity) ? p.activity : 'idle',
            updatedAt,
          };
        }),
        incoming: incoming.docs.map(r => asReq(r, 'from')),
        outgoing: outgoing.docs.map(r => asReq(r, 'to')),
        readTime,
      };
    },
  };
}

// ---- Presence throttle ----

const OFFLINE = Object.freeze({ state: 'offline', project: null, activity: 'idle' });
const STOP_WAIT_MS = 1500;

// Keeps presence writes polite: the first one goes out at once, later ones are at least minGapMs apart (changes in
// between collapse into the latest), the current state is rewritten every heartbeatMs so friends can tell we are alive,
// and a failed write is not retried until the next heartbeat. stop() writes `offline` once, waiting at most 1.5 s.
function presenceThrottle({
  write,
  setTimer = (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
  clearTimer = clearTimeout,
  now = Date.now,
  minGapMs = 10_000,
  heartbeatMs = 60_000,
}) {
  let latest = null;     // what we want friends to see
  let lastOk = null;     // what the last successful write said
  let lastAt = null;     // when the last write was started
  let flushTimer = null;
  let beatTimer = null;
  let inflight = Promise.resolve();
  let stopped = false;
  let stopping = null;
  const same = (a, b) => !!a && !!b && a.state === b.state && a.project === b.project && a.activity === b.activity;

  function send(p) {
    lastAt = now();
    clearTimer(flushTimer); flushTimer = null;
    clearTimer(beatTimer);
    beatTimer = setTimer(beat, heartbeatMs);
    const run = (async () => {
      try { await write(p); lastOk = p; } catch { lastOk = null; }
    })();
    inflight = run;
    return run;
  }
  function beat() { beatTimer = null; if (!stopped && latest) send(latest); }
  function flush() { flushTimer = null; if (!stopped && !same(latest, lastOk)) send(latest); }

  return {
    set(p) {
      if (stopped) return;
      latest = { state: p.state, project: p.project ?? null, activity: p.activity };
      if (same(latest, lastOk)) return;
      const wait = lastAt === null ? 0 : lastAt + minGapMs - now();
      if (wait <= 0) send(latest);
      else if (!flushTimer) flushTimer = setTimer(flush, wait);
    },

    stop() {
      if (stopping) return stopping;
      stopped = true;
      clearTimer(flushTimer); flushTimer = null;
      clearTimer(beatTimer); beatTimer = null;
      if (!latest) return (stopping = Promise.resolve()); // never shared anything, nothing to take back
      let giveUp;
      const timeout = new Promise(resolve => { giveUp = setTimer(resolve, STOP_WAIT_MS); });
      const bye = inflight.then(() => write(OFFLINE)).catch(() => {});
      stopping = Promise.race([bye, timeout]).then(() => { clearTimer(giveUp); });
      return stopping;
    },
  };
}

module.exports = { FriendsError, presenceThrottle, friendsApi, firebaseSession, refreshSession, SessionCache, SERVER_TIME, toFields, transformsOf, fromDoc, normEmail, sha256hex };
