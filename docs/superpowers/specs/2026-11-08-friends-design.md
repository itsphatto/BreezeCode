# Friends: design

Date: 2026-11-08
Status: draft for review

## Goal

Let Breeze users add each other by email and see what their friends are working on: whether they're online, which project they have open, and what they're doing (editing, an agent building, debugging, chatting in Breeze Space). This adds a social layer that fits the product's "fun while you wait" character, while sharing nothing beyond a status line.

## Decisions

| Question | Decision |
|---|---|
| Where shared data lives | A hosted service: Firebase Auth + Cloud Firestore, called over REST from the main process (no SDK dependency) |
| What friends see | Online/away/offline, the open folder's name (can be hidden), and the current activity. No file names, code, prompts or paths. |
| How adding works | Request + accept. You only see each other once the request is accepted. |
| Identity | The verified email of the signed-in GitHub or Google account, lowercased |

Out of scope: chat or messages, notifications outside the app, seeing a friend's files or agent output, blocking (Remove covers it for now), and following more than one account at once.

## Why Firebase

Firebase Auth's `accounts:signInWithIdp` REST call takes the **GitHub access token** and the **Google access token** Breeze already holds, so users never sign in a second time. Firestore security rules give per-user privacy without us running a server. The REST APIs fit the existing no-dependency style of `sync.js`, `github.js` and `discord.js`.

The trade-off is that live updates over REST mean polling. Firestore's streaming `Listen` API isn't practical without the SDK. For presence, polling every 30 seconds is enough.

Supabase was considered and rejected because it can't exchange a GitHub token for a session without a second browser sign-in or a custom Edge Function.

## Architecture

```
renderer (friends.ts, presence hooks)
    │  window.breeze.friends.*  (preload)
    ▼
main.js  ── IPC handlers 'friends:*'
    │
    ▼
src/main/friends.js   (pure module: Firebase REST client + presence throttle)
    │  fetch
    ▼
Firebase Auth (identitytoolkit / securetoken)   Cloud Firestore REST
```

### Units

**`src/main/friends.js`** is a new module that holds no Electron state, so it can be unit-tested with an injected `fetch`. It contains:

- `firebaseSession({ apiKey, provider, accessToken })`
  - Calls `signInWithIdp` with `postBody` `access_token=…&providerId=github.com` (or `google.com`) and returns `{ uid, idToken, refreshToken, email, expiresAt }`.
  - Throws `FriendsError('reauth')` on a 400 caused by an invalid token.
- `refreshSession({ apiKey, refreshToken })` exchanges the refresh token at `securetoken.googleapis.com/v1/token`.
- `firestore({ projectId, idToken, fetch })` is a small client with `get`, `set` (PATCH with an update mask), `delete`, `runQuery` and `batchWrite`. It maps Firestore's typed value format to plain JSON and back.
- These high-level calls are built on that client:
  - `upsertProfile`
  - `sendRequest(toEmail)`
  - `listIncoming()`
  - `listOutgoing()`
  - `accept(requestId)`
  - `decline(requestId)`
  - `cancel(requestId)`
  - `listFriends()`
  - `readPresence(uids)`
  - `writePresence(p)`
  - `removeFriend(uid)`
- `presenceThrottle({ write, now, minGapMs = 10_000, heartbeatMs = 60_000 })` coalesces changes:
  - The first change is written at once.
  - Later changes are written no more than once every 10 seconds.
  - A heartbeat rewrites the same state every 60 seconds.
  - `stop()` writes `state: 'offline'` once.
- `FriendsError` has `code` set to `'not-configured'`, `'signed-out'`, `'reauth'`, `'invalid-email'`, `'self'`, `'exists'` or `'network'`.

**`main.js`** wiring:

- `friendsConfig()` reads `firebase.apiKey` and `firebase.projectId` from `breeze.config.json`, or the env vars `BREEZE_FIREBASE_API_KEY` and `BREEZE_FIREBASE_PROJECT_ID`, following the same pattern as `authConfig()` and `discordClientId()`.
- Session handling:
  - A session is created lazily from the **active** account: `githubToken(id)` for GitHub, or `syncEngine.googleAccessToken` for Google.
  - The Firebase refresh token is stored encrypted with `setSecret('firebase:<acct>', …)`.
  - The session is cached in memory and refreshed 5 minutes before it expires.
  - Switching or signing out of the account drops the session and stops the presence throttle.
- The IPC handlers return `{ error, code }` on failure, the same way `syncHandle` does:
  - `friends:status`: configured? signed in? your email
  - `friends:list`: friends with their presence, plus incoming and outgoing requests
  - `friends:add`
  - `friends:accept`
  - `friends:decline`
  - `friends:cancel`
  - `friends:remove`
  - `friends:presence`: the renderer pushes its current activity

**`preload.js`** adds `window.breeze.friends.{status, list, add, accept, decline, cancel, remove, setPresence}`.

**`src/renderer/breeze/friends.ts`** is the new renderer unit:

- `friendsActivity()` derives `{ project, activity }` from app state, reusing the same signals as `discordActivity()` in `discord.ts`:
  - a working agent → `'agent'`
  - `appState.mode === 'box'` → `'space'`
  - an active debug session → `'debug'`
  - an open file → `'editing'`
  - none of these → `'idle'`
  - `project` is `rootInfo?.name`, or `null` when the "Share project name" setting is off.
- A coalesced `pushFriendsPresence()` is called from the same places that already call the Discord update.
- The Friends view: rendering, polling and the add form.
- Window blur/focus and a 5-minute no-input timer flip `state` between `online` and `away`.

## Data model (Firestore)

```
users/{uid}
  email: string        // lowercased verified email from the Firebase token
  name: string
  avatar: string|null
  updatedAt: timestamp

presence/{uid}
  state: 'online' | 'away' | 'offline'
  project: string|null // folder name only, ≤ 80 chars
  activity: 'editing' | 'agent' | 'debug' | 'space' | 'idle'
  updatedAt: timestamp // request.time

requests/{fromUid}_{toEmailHash}
  fromUid, fromEmail, fromName, fromAvatar
  toEmail: string      // lowercased
  toUid: string|null   // filled in on accept
  status: 'pending' | 'accepted' | 'declined'
  createdAt: timestamp

friends/{uid}/list/{friendUid}
  email, name, avatar, since: timestamp
```

- `toEmailHash` is the SHA-256 of the lowercased email (hex). This keeps the document id deterministic, so sending the same request twice is idempotent, and keeps raw emails out of ids.
- Accepting runs one `commit` that:
  - sets the request to `accepted` with `toUid`
  - writes `friends/{me}/list/{them}`
  - writes `friends/{them}/list/{me}`
- If both people send each other a request, accepting either one makes them friends. The accept commit also deletes the accepter's own pending request to the other person (a sender may always delete their own request).
- Removing a friend deletes both `list` docs and the accepted request in one commit, so neither side can re-create the friendship later without a new request.

## Security rules (`firestore.rules`, committed to the repo)

`myEmail()` is `request.auth.token.email.lower()`, and it applies only when `request.auth.token.email_verified == true`. Both GitHub and Google provide a verified email; Breeze already requests GitHub's `user:email` scope.

- **users/{uid}**
  - Read: the owner, or anyone in the owner's friends list.
  - Write: the owner only, and `email` must equal `myEmail()`.
- **presence/{uid}**
  - Write: the owner only. The fields are validated (enum values, `project` length, `updatedAt == request.time`).
  - Read: the owner, or a user who appears in `friends/{uid}/list/{reader}`. A rule can check this with `exists()`.
- **requests/{id}**
  - Create: only when `fromUid == auth.uid`, `fromEmail == myEmail()`, `toEmail != myEmail()`, the id matches `auth.uid + '_' + <hash>`, and `status == 'pending'`.
  - Read: the sender, or the user whose `myEmail() == resource.data.toEmail`.
  - Update: only the recipient may set `status` and `toUid == auth.uid`.
  - Delete: the sender at any time (Cancel), or either party once it is `accepted` (Remove friend).
- **friends/{uid}/list/{fid}**
  - Read: the owner.
  - Create: only by the request's recipient, who is either `uid` or `fid`. The request sent by the *other* party must exist with `status == 'accepted'` and `toUid == auth.uid`. The rule checks this with `getAfter()` inside the same commit. The rule rebuilds the request id as `<otherUid> + '_' + hashing.sha256(myEmail()).toHexString().lower()`, which is why the id uses the hash of the recipient's email.
  - Delete: by either party.
- **Email enumeration.** Sending a request returns the same result whether or not the email belongs to a Breeze user. Requests addressed to emails with no user simply wait, and are picked up when someone signs in with that email.
- **Abuse limits.**
  - The client caps outgoing pending requests at 50.
  - Rules reject a `requests` doc whose `fromName` is over 80 chars or whose `toEmail` isn't email-shaped.
  - Rate limiting beyond that is out of scope for v1.

## UI

**Home rail.** A new button `data-home-view="friends"` sits below the Agent (sparkle) button in `.home-rail` (`breeze.html`), using a `users` icon. It has `title="Friends"` and `aria-label="Friends"`. A small dot badge on it shows when there are pending incoming requests. `showHomeView()` in `setup.ts` already switches views by `data-home-view`; the new view is a `.home-view[data-view="friends"]` panel.

**Friends view** has three parts:

1. **Header.** The title "Friends" and an "Add by email" field with an Add button.
   - Enter submits.
   - Invalid email → "That doesn't look like an email address."
   - Your own email → "That's you."
   - On success the field clears and the email appears under Sent, with "Request sent. They'll see it next time they open Breeze."
2. **Requests.** Shown only when there are any.
   - Incoming: avatar, name, email, Accept and Decline.
   - Sent: email, "Waiting", Cancel.
3. **Friends list.** Online friends first, then away, then offline, alphabetical within each group. Each row shows:
   - the avatar with a status dot (green online, amber away, grey offline)
   - the name
   - the status line:

     | Activity | Status line |
     |---|---|
     | `agent` | "Building with an agent in **my-app**" |
     | `editing` | "Coding in **my-app**" |
     | `debug` | "Debugging **my-app**" |
     | `space` | "Chatting in Breeze Space" |
     | `idle`, or project hidden | "Online" or "Away" |

   - offline friends show "Last seen 2h ago" instead
   - a hover menu with Remove, which asks for confirmation
   - Empty state: "Add a friend by email to see what they're building."

**States**

- **Not configured** (no Firebase config): the view explains "Friends isn't set up in this build," with a one-line pointer to `breeze.config.json`.
- **Signed out:** "Sign in with GitHub or Google to add friends," with the existing sign-in button.
- **Reauth:** "Sign in to <provider> again to use Friends."
- **Offline or network failure:** the last list stays visible with a muted "Couldn't reach Friends. Retrying…" line.

**Polling.** While the Friends view is visible, `friends:list` runs every 30 seconds. While it's hidden, it runs every 2 minutes, only to update the request badge. A friend is shown as offline if `presence.updatedAt` is more than 3 minutes old, even if `state` says online. This covers a crash or lost connection, where the app never wrote `offline`.

**Settings → Account** gets two toggles:
- "Share my activity with friends" (default on). When off, the throttle stops and writes `offline` once.
- "Show my project name" (default on).

Both are stored in `appState` like other settings.

## Data flow

1. The app starts and you're signed in. When the renderer calls `friends.status()`, main creates the Firebase session and calls `upsertProfile`.
2. The renderer's state changes and it calls `friends.setPresence({ state, project, activity })`. Main's `presenceThrottle` writes `presence/{uid}`.
3. The Friends view polls `friends.list()`. Main reads `friends/{uid}/list`, then batch-gets `presence/*` for those uids, then runs the incoming and outgoing request queries. It returns one object to the renderer.
4. When the app quits (`before-quit`), the throttle's `stop()` writes `offline`. This is best-effort and limited to 1.5 seconds.

## Error handling

- Every main-side call goes through one wrapper. It retries once after refreshing the session on a 401 or 403 with `UNAUTHENTICATED`. Otherwise it maps the failure to a `FriendsError` code.
- If the access token is rejected (`INVALID_IDP_RESPONSE`), the result is `reauth`. The renderer shows the reauth state; it doesn't loop.
- A failed presence write is dropped silently and retried on the next heartbeat.
- Nothing from Friends ever blocks app startup or the editor.

## Setup (developer / release)

Someone with access to the Firebase console has to do these steps once:

1. Create a Firebase project and enable Firestore (production mode).
2. Enable the GitHub sign-in provider in Authentication, using the **same OAuth App** client id and secret as `breeze.config.json`'s `github.clientId`.
3. Enable the Google provider. Add Breeze's Google OAuth client id under "Safelist client IDs from external projects", or create the Google client in the same GCP project.
   The project should allow multiple accounts per email (Authentication → Settings → User account linking), or Friends shows the `linked` message for people with both a GitHub and Google account.
4. Deploy `firestore.rules`.
5. Put `firebase.apiKey` and `firebase.projectId` in `breeze.config.json`. `breeze.config.example.json` gets the new section, and `scripts/write-config.js` passes it through for release builds.

The Firebase web API key isn't a secret; access is controlled by the rules.

**Risk to verify first.** Before building the UI, a spike confirms that `signInWithIdp` accepts:
- (a) a GitHub **device-flow** access token from Breeze's OAuth App
- (b) the Google access token minted from Breeze's refresh token

If (a) fails, the fallback is a tiny Cloud Function that verifies the GitHub token against `api.github.com/user` and returns a Firebase custom token. That would be a spec change, and we'd discuss it before building.

## Testing

- **`test/friends.test.js`** (node:test, injected fake `fetch`) covers:
  - the session exchange and refresh
  - the Firestore value encode/decode round trip
  - the `sendRequest` doc id and idempotency
  - accept producing a single commit with the three writes
  - error-code mapping, including the reauth path
  - `presenceThrottle` timing with a fake clock: first write immediate, 10 s coalescing, 60 s heartbeat, `stop()` writes offline
- **Rules:** if `firebase-tools` is available, emulator tests in `test/firestore.rules.test.js`. They check that a non-friend can't read presence, a stranger can't read requests addressed to someone else, nobody can forge `fromEmail` or create a `friends` doc without an accepted request, and the email-enumeration path behaves the same either way. These are skipped when the emulator isn't installed.
- **Manual:** two machines, or two Windows users, signed in to different accounts. Check add → accept → presence changes within 30 seconds → remove → hiding the project name → turning sharing off.

## Files

| File | Change |
|---|---|
| `src/main/friends.js` | new: REST client, high-level calls, throttle |
| `src/main/main.js` | config, session cache, `friends:*` IPC, account-switch/sign-out/quit hooks |
| `src/main/preload.js` | `breeze.friends` bridge |
| `src/renderer/breeze/friends.ts` | new: view, polling, presence derivation |
| `src/renderer/breeze.html` | rail button, `friends` home view markup, settings toggles |
| `src/renderer/breeze.css` | Friends view styles using existing tokens |
| `src/renderer/breeze/setup.ts` | register the view with `showHomeView`, badge |
| `src/renderer/breeze/discord.ts` | call `pushFriendsPresence()` alongside the Discord update |
| `firestore.rules` | new |
| `breeze.config.example.json`, `scripts/write-config.js` | `firebase` section |
| `test/friends.test.js` | new |
| `PRODUCT.md` | add Friends to the main surfaces |
