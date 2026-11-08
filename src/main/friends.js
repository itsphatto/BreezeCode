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

module.exports = { FriendsError, SERVER_TIME, toFields, transformsOf, fromDoc, normEmail, sha256hex };
