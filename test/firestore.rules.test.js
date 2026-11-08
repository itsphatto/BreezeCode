// Emulator tests for firestore.rules. They need the Firestore emulator (firebase-tools + Java) and the
// @firebase/rules-unit-testing and firebase modules, none of which are project dependencies, so the whole file is
// skipped unless both the modules load and FIRESTORE_EMULATOR_HOST is set. To run them:
//   npm install --no-save @firebase/rules-unit-testing firebase
//   firebase emulators:exec --only firestore --project demo-breeze "node --test test/firestore.rules.test.js"
// from the repo root; it uses the repo's firebase.json (emulator on its default port 8080). The test loads the rules
// from firestore.rules itself.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

let rut = null;
let fsdk = null;
try {
  rut = require('@firebase/rules-unit-testing');
  fsdk = require('firebase/firestore');
} catch { rut = null; }

const ready = !!(rut && fsdk && process.env.FIRESTORE_EMULATOR_HOST);
if (!ready) {
  test.skip('firestore rules (needs the Firestore emulator and @firebase/rules-unit-testing)', () => {});
} else {
  run();
}

function run() {
  const { initializeTestEnvironment, assertFails, assertSucceeds } = rut;
  const { doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, query, where, writeBatch, serverTimestamp } = fsdk;
  const sha = s => crypto.createHash('sha256').update(s).digest('hex');
  const ALICE = { uid: 'alice', email: 'alice@example.com' };
  const BOB = { uid: 'bob', email: 'bob@example.com' };
  const EVE = { uid: 'eve', email: 'eve@example.com' };
  const rid = (from, toEmail) => `${from.uid}_${sha(toEmail)}`;
  let env;

  const db = (u, verified = true) => env.authenticatedContext(u.uid, { email: u.email, email_verified: verified }).firestore();
  const requestDoc = (from, toEmail, over = {}) => ({
    fromUid: from.uid, fromEmail: from.email, fromName: from.uid, fromAvatar: null,
    toEmail, toUid: null, status: 'pending', createdAt: serverTimestamp(), ...over,
  });
  const send = (from, to, over) => setDoc(doc(db(from), 'requests', rid(from, to.email)), requestDoc(from, to.email, over));
  // The accept commit exactly as friends.js makes it.
  function acceptBatch(me, them, { reverse = false } = {}) {
    const d = db(me);
    const b = writeBatch(d);
    b.update(doc(d, 'requests', rid(them, me.email)), { status: 'accepted', toUid: me.uid });
    b.set(doc(d, 'friends', me.uid, 'list', them.uid), { email: them.email, name: them.uid, avatar: null, since: serverTimestamp() });
    b.set(doc(d, 'friends', them.uid, 'list', me.uid), { email: me.email, name: me.uid, avatar: null, since: serverTimestamp() });
    if (reverse) b.delete(doc(d, 'requests', rid(me, them.email)));
    return b.commit();
  }
  const presence = u => setDoc(doc(db(u), 'presence', u.uid), { state: 'online', project: 'breeze', activity: 'editing', updatedAt: serverTimestamp() });

  test.before(async () => {
    env = await initializeTestEnvironment({
      projectId: 'demo-breeze',
      firestore: { rules: fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8') },
    });
  });
  test.after(async () => { if (env) await env.cleanup(); });
  test.beforeEach(async () => { await env.clearFirestore(); });

  // ---- the five from the brief ----

  test('non-friend cannot read presence', async () => {
    await assertSucceeds(presence(ALICE));
    await assertFails(getDoc(doc(db(EVE), 'presence', 'alice')));
    await assertSucceeds(getDoc(doc(db(ALICE), 'presence', 'alice')));
  });

  test('stranger cannot read a request to someone else', async () => {
    await assertSucceeds(send(ALICE, BOB));
    await assertFails(getDoc(doc(db(EVE), 'requests', rid(ALICE, BOB.email))));
    await assertSucceeds(getDoc(doc(db(BOB), 'requests', rid(ALICE, BOB.email))));
    await assertSucceeds(getDoc(doc(db(ALICE), 'requests', rid(ALICE, BOB.email))));
    // A query not pinned to the reader is refused as a whole.
    await assertFails(getDocs(query(collection(db(EVE), 'requests'), where('status', '==', 'pending'))));
    await assertFails(getDocs(query(collection(db(EVE), 'requests'), where('toEmail', '==', BOB.email), where('status', '==', 'pending'))));
  });

  test('cannot forge fromEmail', async () => {
    await assertFails(send(EVE, BOB, { fromEmail: ALICE.email }));
    await assertFails(send(EVE, BOB, { fromUid: 'alice' }));
    await assertFails(setDoc(doc(db(EVE), 'requests', rid(ALICE, BOB.email)), requestDoc(EVE, BOB.email)));
    // An unverified email is no identity at all.
    await assertFails(setDoc(doc(db(EVE, false), 'requests', rid(EVE, BOB.email)), requestDoc(EVE, BOB.email)));
  });

  test('cannot create a friends doc without an accepted request', async () => {
    const d = db(EVE);
    const entry = (u) => ({ email: u.email, name: u.uid, avatar: null, since: serverTimestamp() });
    await assertFails(setDoc(doc(d, 'friends', 'eve', 'list', 'bob'), entry(BOB)));
    await assertFails(setDoc(doc(d, 'friends', 'bob', 'list', 'eve'), entry(EVE)));
    // A pending request is not enough either.
    await assertSucceeds(send(BOB, EVE));
    await assertFails(setDoc(doc(d, 'friends', 'eve', 'list', 'bob'), entry(BOB)));
    // Nor is the sender's side of an accepted request: Bob cannot write lists for a request he sent.
    await assertSucceeds(acceptBatch(EVE, BOB));
    await env.withSecurityRulesDisabled(async c => { await deleteDoc(doc(c.firestore(), 'friends', 'bob', 'list', 'eve')); });
    await assertFails(setDoc(doc(db(BOB), 'friends', 'bob', 'list', 'eve'), entry(EVE)));
  });

  test('sender cannot mark own request accepted', async () => {
    await assertSucceeds(send(ALICE, BOB));
    await assertFails(updateDoc(doc(db(ALICE), 'requests', rid(ALICE, BOB.email)), { status: 'accepted', toUid: 'alice' }));
    await assertFails(updateDoc(doc(db(ALICE), 'requests', rid(ALICE, BOB.email)), { status: 'accepted', toUid: 'bob' }));
  });

  // ---- what friends.js does must work ----

  test('the client flows: send, list, accept, presence, remove', async () => {
    await assertSucceeds(send(ALICE, BOB));
    await assertSucceeds(send(BOB, ALICE)); // both asked: Bob's accept deletes his own request too
    await assertSucceeds(getDocs(query(collection(db(BOB), 'requests'), where('toEmail', '==', BOB.email), where('status', '==', 'pending'))));
    await assertSucceeds(getDocs(query(collection(db(ALICE), 'requests'), where('fromUid', '==', 'alice'), where('status', '==', 'pending'))));
    await assertSucceeds(acceptBatch(BOB, ALICE, { reverse: true }));
    // Accepted is final: nobody flips it to declined afterwards.
    await assertFails(updateDoc(doc(db(BOB), 'requests', rid(ALICE, BOB.email)), { status: 'declined', toUid: 'bob' }));
    await assertSucceeds(getDocs(collection(db(BOB), 'friends', 'bob', 'list')));
    await assertFails(getDocs(collection(db(ALICE), 'friends', 'bob', 'list')));
    await assertSucceeds(presence(ALICE));
    await assertSucceeds(getDoc(doc(db(BOB), 'presence', 'alice')));
    await assertSucceeds(getDocs(query(collection(db(ALICE), 'requests'), where('fromUid', '==', 'alice'), where('status', '==', 'accepted'))));
    await assertSucceeds(getDocs(query(collection(db(ALICE), 'requests'), where('toEmail', '==', ALICE.email), where('status', '==', 'accepted'))));
    // Remove friend from the sender's side: both list docs and the accepted request in one commit.
    const d = db(ALICE);
    const b = writeBatch(d);
    b.delete(doc(d, 'friends', 'alice', 'list', 'bob'));
    b.delete(doc(d, 'friends', 'bob', 'list', 'alice'));
    b.delete(doc(d, 'requests', rid(ALICE, BOB.email)));
    await assertSucceeds(b.commit());
    await assertFails(getDoc(doc(db(BOB), 'presence', 'alice')));
  });

  // removeFriend's queries, pinned to both uids in each direction.
  const pairQuery = (who, from, to) => getDocs(query(collection(db(who), 'requests'),
    where('fromUid', '==', from.uid), where('toUid', '==', to.uid), where('status', '==', 'accepted')));

  test('removeFriend finds the accepted request from either side with a query pinned to both uids', async () => {
    await assertSucceeds(send(ALICE, BOB));
    await assertSucceeds(send(EVE, BOB));
    await assertSucceeds(acceptBatch(BOB, ALICE));
    await assertSucceeds(acceptBatch(BOB, EVE));
    const asBob = await assertSucceeds(pairQuery(BOB, ALICE, BOB));
    assert.deepEqual(asBob.docs.map(d => d.id), [rid(ALICE, BOB.email)]);
    assert.equal((await assertSucceeds(pairQuery(BOB, BOB, ALICE))).size, 0);
    const asAlice = await assertSucceeds(pairQuery(ALICE, ALICE, BOB));
    assert.deepEqual(asAlice.docs.map(d => d.id), [rid(ALICE, BOB.email)]);
    assert.equal((await assertSucceeds(pairQuery(ALICE, BOB, ALICE))).size, 0);
    // Someone outside the pair may not ask.
    await assertFails(pairQuery(EVE, ALICE, BOB));
  });

  test('list docs are only born in the commit that accepts: a leftover accepted request cannot re-create them', async () => {
    await assertSucceeds(send(ALICE, BOB));
    await assertSucceeds(acceptBatch(BOB, ALICE));
    await env.withSecurityRulesDisabled(async c => {
      const d = c.firestore();
      await deleteDoc(doc(d, 'friends', 'bob', 'list', 'alice'));
      await deleteDoc(doc(d, 'friends', 'alice', 'list', 'bob'));
    });
    const d = db(BOB);
    const b = writeBatch(d);
    b.set(doc(d, 'friends', 'bob', 'list', 'alice'), { email: ALICE.email, name: 'alice', avatar: null, since: serverTimestamp() });
    b.set(doc(d, 'friends', 'alice', 'list', 'bob'), { email: BOB.email, name: 'bob', avatar: null, since: serverTimestamp() });
    await assertFails(b.commit());
    await assertFails(setDoc(doc(d, 'friends', 'alice', 'list', 'bob'), { email: BOB.email, name: 'bob', avatar: null, since: serverTimestamp() }));
  });

  test('a sender cannot see that a request was declined', async () => {
    await assertSucceeds(send(ALICE, BOB));
    await assertSucceeds(getDoc(doc(db(ALICE), 'requests', rid(ALICE, BOB.email))));
    await assertSucceeds(updateDoc(doc(db(BOB), 'requests', rid(ALICE, BOB.email)), { status: 'declined', toUid: 'bob' }));
    await assertFails(getDoc(doc(db(ALICE), 'requests', rid(ALICE, BOB.email))));
    // The client's own sender queries pin status, so they still run (and the declined one simply is not there).
    const pending = await assertSucceeds(getDocs(query(collection(db(ALICE), 'requests'), where('fromUid', '==', 'alice'), where('status', '==', 'pending'))));
    assert.equal(pending.size, 0);
    await assertSucceeds(getDocs(query(collection(db(ALICE), 'requests'), where('fromUid', '==', 'alice'), where('status', '==', 'accepted'))));
    // An unpinned query could include the declined one, so it is refused.
    await assertFails(getDocs(query(collection(db(ALICE), 'requests'), where('fromUid', '==', 'alice'))));
    // The recipient still sees it.
    await assertSucceeds(getDoc(doc(db(BOB), 'requests', rid(ALICE, BOB.email))));
  });

  test('the recipient can remove an accepted friend', async () => {
    await assertSucceeds(send(ALICE, BOB));
    await assertSucceeds(acceptBatch(BOB, ALICE));
    const d = db(BOB);
    const b = writeBatch(d);
    b.delete(doc(d, 'friends', 'bob', 'list', 'alice'));
    b.delete(doc(d, 'friends', 'alice', 'list', 'bob'));
    b.delete(doc(d, 'requests', rid(ALICE, BOB.email)));
    await assertSucceeds(b.commit());
  });

  test('decline, and cancel by the sender only', async () => {
    await assertSucceeds(send(ALICE, BOB));
    await assertFails(deleteDoc(doc(db(BOB), 'requests', rid(ALICE, BOB.email)))); // pending: not the recipient's to delete
    await assertFails(updateDoc(doc(db(EVE), 'requests', rid(ALICE, BOB.email)), { status: 'declined', toUid: 'eve' }));
    await assertFails(updateDoc(doc(db(BOB), 'requests', rid(ALICE, BOB.email)), { status: 'declined', toUid: 'bob', fromName: 'x' }));
    await assertSucceeds(updateDoc(doc(db(BOB), 'requests', rid(ALICE, BOB.email)), { status: 'declined', toUid: 'bob' }));
    // Declined stays declined; the sender's re-send (a create on an existing doc) is refused.
    await assertFails(updateDoc(doc(db(BOB), 'requests', rid(ALICE, BOB.email)), { status: 'accepted', toUid: 'bob' }));
    await assertFails(send(ALICE, BOB));
    await assertFails(deleteDoc(doc(db(EVE), 'requests', rid(ALICE, BOB.email))));
    await assertSucceeds(deleteDoc(doc(db(ALICE), 'requests', rid(ALICE, BOB.email))));
  });

  test('a request to an email nobody uses is accepted the same way', async () => {
    await assertSucceeds(send(ALICE, { uid: 'nobody', email: 'nobody@nowhere.example' }));
  });

  test('request shape is checked', async () => {
    await assertFails(send(ALICE, ALICE)); // to myself
    await assertFails(send(ALICE, BOB, { fromName: 'x'.repeat(81) }));
    await assertFails(send(ALICE, BOB, { status: 'accepted' }));
    await assertFails(send(ALICE, BOB, { toUid: 'bob' }));
    await assertFails(send(ALICE, BOB, { createdAt: new Date(0) }));
    await assertFails(send(ALICE, BOB, { extra: 1 }));
    await assertFails(setDoc(doc(db(ALICE), 'requests', rid(ALICE, 'not-an-email')), requestDoc(ALICE, 'not-an-email')));
    await assertFails(setDoc(doc(db(ALICE), 'requests', rid(ALICE, 'Bob@Example.com')), requestDoc(ALICE, 'Bob@Example.com')));
    await assertFails(setDoc(doc(db(ALICE), 'requests', `alice_${sha('carol@example.com')}`), requestDoc(ALICE, BOB.email)));
  });

  test('presence and profile shape is checked', async () => {
    const p = (o) => setDoc(doc(db(ALICE), 'presence', 'alice'), { state: 'online', project: null, activity: 'idle', updatedAt: serverTimestamp(), ...o });
    await assertSucceeds(p({}));
    await assertSucceeds(p({ project: 'x'.repeat(80) }));
    await assertFails(p({ project: 'x'.repeat(81) }));
    await assertFails(p({ state: 'busy' }));
    await assertFails(p({ activity: 'reading-your-code' }));
    await assertFails(p({ file: 'src/secret.js' }));
    await assertFails(p({ updatedAt: new Date(0) }));
    await assertFails(setDoc(doc(db(EVE), 'presence', 'alice'), { state: 'online', project: null, activity: 'idle', updatedAt: serverTimestamp() }));
    const u = (who, o) => setDoc(doc(db(who), 'users', 'alice'), { email: ALICE.email, name: 'Alice', avatar: null, updatedAt: serverTimestamp(), ...o });
    await assertSucceeds(u(ALICE, {}));
    await assertFails(u(ALICE, { email: BOB.email }));
    await assertFails(u(EVE, {}));
    await assertFails(getDoc(doc(db(EVE), 'users', 'alice')));
  });
}
