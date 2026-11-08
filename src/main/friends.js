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
  denied: "Friends can't do that.",
  unverified: "This account's email isn't verified, so Friends can't use it.",
  network: "Couldn't reach Friends. Retrying…",
};

// code is one of: not-configured, signed-out, reauth, unverified, invalid-email, self, exists, too-many, gone, denied, network.
// `message` is optional; each code has a default line.
class FriendsError extends Error {
  constructor(code, message) { super(message || COPY[code] || code); this.code = code; }
}

const sha256hex = s => crypto.createHash('sha256').update(String(s)).digest('hex');

// Trimmed, lowercased email, or null when it does not look like one.
function normEmail(s) {
  if (typeof s !== 'string') return null;
  const e = s.trim().toLowerCase();
  if (e.length > 254) return null; // the longest address SMTP allows; the rules refuse longer
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
  // Identity is the verified email; an account whose email is unverified cannot be matched safely.
  if (body.emailVerified !== true) throw new FriendsError('unverified');
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
const NAME_MAX = 80;      // the rules refuse a longer fromName
const AVATAR_MAX = 2048;  // and a longer avatar URL
const STATES = new Set(['online', 'away', 'offline']);
const ACTIVITIES = new Set(['editing', 'agent', 'debug', 'space', 'idle']);
const ID_OK = /^[A-Za-z0-9_-]{1,200}$/;

// Cuts a string to `max` UTF-16 units without leaving half an emoji at the end; null for a non-string or empty one.
function clipText(p, max) {
  if (typeof p !== 'string' || !p) return null;
  let s = p.slice(0, max);
  if (/[\uD800-\uDBFF]$/.test(s)) s = s.slice(0, -1);
  return s;
}
// A folder name, at most 80 characters.
const clipProject = p => clipText(p, PROJECT_MAX);
// A display name, at most 80 characters.
const clipName = n => clipText(n, NAME_MAX);
// An avatar URL. A cut URL points nowhere, so one that is too long is dropped instead.
// Only a web picture: an http(s) URL of sane length. Anything else (javascript:, data:, file:, …) is dropped.
const safeAvatar = a => (typeof a === 'string' && a.length <= AVATAR_MAX && /^https?:\/\/[^\s]+$/i.test(a) ? a : null);

// Everything the signed-in user can do with friends. `session` is { uid, idToken, email } from SessionCache; the caller
// gets a new api whenever the session changes. A 401 throws reauth (a 403 is `denied`, or `gone` where a call says so); main refreshes the session and retries once.
function friendsApi({ projectId, session, fetch: fetchFn = globalThis.fetch, me = {}, now = Date.now }) {
  const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  const docName = p => `projects/${projectId}/databases/(default)/documents/${p}`;
  const myUid = session.uid;
  const myEmail = session.email;
  const myName = clipName(me.name) || clipName(myEmail);
  const myAvatar = safeAvatar(me.avatar);
  const safe = id => { if (typeof id !== 'string' || !ID_OK.test(id)) throw new FriendsError('gone'); return id; };
  const needEmail = () => { if (!myEmail) throw new FriendsError('reauth'); };

  // `allow` lists error statuses the caller wants back as { status } instead of a throw.
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
    if (res.status === 401) throw new FriendsError('reauth');
    if (res.status === 403) throw new FriendsError('denied');
    const why = data && data.error && data.error.message;
    throw new FriendsError('network', why ? `Friends: ${why}` : undefined);
  }

  const commit = async (writes, allow = []) => (await call('POST', `${base}:commit`, { writes }, allow)).status;
  // A write of a whole document. SERVER_TIME fields become REQUEST_TIME transforms.
  const put = (path, obj, { mask, exists } = {}) => {
    const w = { update: { name: docName(path), fields: toFields(obj) } };
    const tf = transformsOf(obj);
    if (tf.length) w.updateTransforms = tf;
    if (mask) w.updateMask = { fieldPaths: mask };
    if (exists !== undefined) w.currentDocument = { exists };
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

  // A request addressed to me that is still pending, or throws gone (404, or 403 after the sender cancelled it).
  async function pendingRequestForMe(id) {
    const { status, data } = await call('GET', `${base}/requests/${id}`, undefined, [403, 404]);
    if (status !== 200) throw new FriendsError('gone');
    const req = fromDoc(data);
    if (req.status !== 'pending' || req.toEmail !== myEmail) throw new FriendsError('gone');
    return req;
  }

  const asReq = (r, who) => (who === 'from'
    ? { id: r.id, email: normEmail(r.fromEmail) || String(r.fromEmail || ''), name: r.fromName || null, avatar: safeAvatar(r.fromAvatar), createdAt: r.createdAt ?? null }
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
      // exists:false makes this a create. If the request is already there (409, or 403 when the rules judge it as an update),
      // it stays as it is and counts as sent: the sender never learns what the other side did.
      await commit([put(`requests/${id}`, {
        fromUid: myUid, fromEmail: myEmail, fromName: myName, fromAvatar: myAvatar,
        toEmail: email, toUid: null, status: 'pending', createdAt: SERVER_TIME,
      }, { exists: false })], [403, 409]);
      return { id };
    },

    async accept(requestId) {
      needEmail();
      const id = safe(requestId);
      const req = await pendingRequestForMe(id);
      const theirEmail = normEmail(req.fromEmail);
      if (!theirEmail || !req.fromUid) throw new FriendsError('gone');
      const them = safe(req.fromUid);
      const writes = [
        put(`requests/${id}`, { status: 'accepted', toUid: myUid }, { mask: ['status', 'toUid'], exists: true }),
        put(`friends/${myUid}/list/${them}`, { email: theirEmail, name: clipName(req.fromName) || clipName(theirEmail), avatar: safeAvatar(req.fromAvatar), since: SERVER_TIME }),
        put(`friends/${them}/list/${myUid}`, { email: myEmail, name: myName, avatar: myAvatar, since: SERVER_TIME }),
      ];
      // If I had also asked them, that request is now pointless; a sender may always delete their own.
      const reverseId = `${myUid}_${sha256hex(theirEmail)}`;
      const mine = await queryRequests({ fromUid: myUid, status: 'pending' }, MAX_PENDING_OUT + 1);
      if (mine.docs.some(r => r.id === reverseId)) writes.push(del(`requests/${reverseId}`));
      // A decline marker I may have left for this request goes too, so a later request with the same id (after a
      // remove) is not hidden.
      writes.push(del(`friends/${myUid}/declined/${id}`));
      // The sender may have cancelled between my read and this write.
      const st = await commit(writes, [403, 404, 409]);
      if (st >= 400) throw new FriendsError('gone');
    },

    async decline(requestId) {
      needEmail();
      const id = safe(requestId);
      await pendingRequestForMe(id); // a stale row for a request that was accepted must not be marked declined
      // The request itself is left pending, so the sender sees exactly what they would if I had never looked: the
      // decline is a private marker under my own friends doc, and list() hides marked requests.
      const st = await commit([put(`friends/${myUid}/declined/${id}`, { at: SERVER_TIME })], [403, 404]);
      if (st >= 400) throw new FriendsError('gone');
    },

    async cancel(requestId) {
      const id = safe(requestId);
      if (!id.startsWith(`${myUid}_`)) throw new FriendsError('gone');
      // Already deleted: Firestore may answer 403 (rules cannot see a document that is not there) or 404.
      const st = await commit([del(`requests/${id}`)], [403, 404]);
      if (st >= 400) throw new FriendsError('gone');
    },

    async removeFriend(uid) {
      needEmail();
      const them = safe(uid);
      // The accepted request lives under whoever sent it: ask for both directions, pinned to the two of us, so it is
      // found however many other friends there are (a request left behind would let its recipient re-create the pair).
      const [theirs, mine] = await Promise.all([
        queryRequests({ fromUid: them, toUid: myUid, status: 'accepted' }),
        queryRequests({ fromUid: myUid, toUid: them, status: 'accepted' }),
      ]);
      const ids = [...new Set([...theirs.docs, ...mine.docs].map(r => r.id))];
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
      let readTime = Math.max(incoming.readTime, outgoing.readTime);
      // Incoming requests I declined stay pending for the sender; my own markers hide them here (one batchGet).
      const declined = new Set();
      if (incoming.docs.length) {
        const names = incoming.docs.map(r => docName(`friends/${myUid}/declined/${safe(r.id)}`));
        const { data } = await call('POST', `${base}:batchGet`, { documents: names });
        for (const r of Array.isArray(data) ? data : []) if (r.found) declined.add(fromDoc(r.found).id);
      }
      // Presence is batch-read; a friend who never shared has no doc, which is "offline", not an error.
      const presence = new Map();
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
            uid: f.id, email: f.email, name: f.name || f.email, avatar: safeAvatar(f.avatar),
            state: live ? p.state : 'offline',
            project: live ? clipProject(p.project) : null,
            activity: live && ACTIVITIES.has(p.activity) ? p.activity : 'idle',
            updatedAt,
          };
        }),
        incoming: incoming.docs.filter(r => !declined.has(r.id)).map(r => asReq(r, 'from')),
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

// ---- Main-process helpers ----

// Runs `attempt`; when it fails with reauth (a 401: the session went stale), calls `renew()` and runs it once more.
// Any other failure, including denied, is final: retrying a 403 would only fail the same way.
async function callWithRetry(attempt, renew) {
  try { return await attempt(); } catch (e) {
    if (!(e instanceof FriendsError) || e.code !== 'reauth') throw e;
    await renew();
    return attempt();
  }
}

// What the renderer gets for a failure: { error, code }, or null when `e` is not a FriendsError (a real bug, left to throw).
// IPC drops an error's code, so it travels in the reply. A reauth names the account's provider ("GitHub" / "Google").
function friendsReply(e, provider) {
  if (!(e instanceof FriendsError)) return null;
  const error = e.code === 'reauth' && provider ? `Sign in to ${provider} again to use Friends.` : e.message;
  return { error, code: e.code };
}

module.exports = { callWithRetry, friendsReply, FriendsError, clipName, safeAvatar, presenceThrottle, friendsApi, firebaseSession, refreshSession, SessionCache, SERVER_TIME, toFields, transformsOf, fromDoc, normEmail, sha256hex };
