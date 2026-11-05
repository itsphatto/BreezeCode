// GitHub pull request client. Pure: it takes a token and a fetch, so tests can fake the network.

const API = 'https://api.github.com';
const MAX_FILES = 3000; // the API itself stops listing a pull request's files here
const MAX_COMMITS = 250;
const MAX_COMMENTS = 250;
const MAX_COMMENT_LEN = 65536; // GitHub's own limit on a comment's body

// Reads owner/repo out of an https, scp-style or ssh GitHub remote. Anything else is null.
function parseGithubRemote(url) {
  const m = /^(?:https?:\/\/|ssh:\/\/git@|git@)github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(String(url || '').trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}

const CODES = { 401: 'reauth', 403: 'forbidden', 404: 'not-found', 405: 'not-mergeable', 409: 'head-changed' };

class GithubError extends Error {
  constructor(message, code, status, extra = {}) {
    super(message);
    this.name = 'GithubError';
    this.code = code;
    this.status = status;
    Object.assign(this, extra); // resetAt (epoch seconds, or null) on a 'rate-limit'
  }
}

// GitHub says "rate limited" with a 429, or with a 403 whose x-ratelimit-remaining is 0 (an ordinary 403 is a
// permission problem). The reset time is when the limit lifts, in epoch seconds; null when GitHub didn't say.
function rateLimitOf(res) {
  const header = name => (typeof res.headers?.get === 'function' ? res.headers.get(name) : null);
  if (res.status !== 429 && !(res.status === 403 && header('x-ratelimit-remaining') === '0')) return null;
  const num = name => { const v = header(name); return v == null || v === '' ? NaN : Number(v); };
  const reset = num('x-ratelimit-reset');
  if (Number.isFinite(reset) && reset > 0) return { resetAt: reset };
  const after = num('retry-after');
  return { resetAt: Number.isFinite(after) && after >= 0 ? Math.ceil(Date.now() / 1000 + after) : null };
}

const normalizePull = p => ({
  number: p.number,
  title: p.title,
  author: p.user?.login ?? '',
  avatar: p.user?.avatar_url ?? '',
  head: {
    ref: p.head.ref,
    // A deleted fork has no repo, so the label GitHub gives us is unreliable.
    label: p.head.repo ? p.head.label : `unknown:${p.head.ref}`,
    sha: p.head.sha,
    repo: p.head.repo?.full_name ?? null,
  },
  base: p.base.ref,
  draft: !!p.draft,
  ...(typeof p.commits === 'number' ? { commits: p.commits } : {}),
  mergeable: p.mergeable ?? null,
  mergeableState: p.mergeable_state ?? 'unknown',
  url: p.html_url,
  createdAt: p.created_at,
});

const normalizeFile = f => ({
  path: f.filename,
  previous: f.previous_filename ?? null,
  status: f.status,
  additions: f.additions ?? 0,
  deletions: f.deletions ?? 0,
  patch: f.patch ?? null, // GitHub leaves the patch out for binary and very large files
});

const normalizeCommit = c => ({
  sha: c.sha,
  message: c.commit?.message ?? '',
  author: c.commit?.author?.name ?? '',
  avatar: c.author?.avatar_url ?? null,
  date: c.commit?.author?.date ?? null,
});

const normalizeComment = c => ({
  id: c.id,
  author: c.user?.login ?? '',
  avatar: c.user?.avatar_url ?? null,
  body: c.body ?? '',
  createdAt: c.created_at ?? null,
  url: c.html_url ?? '',
});

function githubClient({ token, fetch: f = fetch }) {
  const request = async (method, path, body) => {
    let res;
    try {
      res = await f(`${API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Breeze-IDE', 'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new GithubError(`Could not reach GitHub: ${e.message}`, 'http', 0);
    }
    let data = null;
    try { data = res.status === 204 ? null : await res.json(); } catch { /* an empty or non-JSON body */ }
    if (res.ok) return data;
    const limited = rateLimitOf(res);
    if (limited) throw new GithubError(data?.message || "GitHub's rate limit was reached", 'rate-limit', res.status, limited);
    throw new GithubError(data?.message || `GitHub returned ${res.status}`, CODES[res.status] || 'http', res.status);
  };

  // Walks numbered pages of 100 until one is short or `limit` items are collected.
  const paged = async (path, limit) => {
    const out = [];
    for (let page = 1; out.length < limit; page++) {
      const items = await request('GET', `${path}?per_page=100&page=${page}`);
      out.push(...items);
      if (items.length < 100) break;
    }
    return out.slice(0, limit);
  };

  const rp = (o, r) => `/repos/${encodeURIComponent(o)}/${encodeURIComponent(r)}`;

  return {
    async listPulls(o, r, base) {
      const pulls = await request('GET', `${rp(o, r)}/pulls?state=open&base=${encodeURIComponent(base)}&per_page=50`);
      return pulls.map(normalizePull);
    },
    async getPull(o, r, n) {
      return normalizePull(await request('GET', `${rp(o, r)}/pulls/${n}`));
    },
    async pullCommits(o, r, n) {
      return (await paged(`${rp(o, r)}/pulls/${n}/commits`, MAX_COMMITS)).map(normalizeCommit);
    },
    async pullFiles(o, r, n) {
      return (await paged(`${rp(o, r)}/pulls/${n}/files`, MAX_FILES)).map(normalizeFile);
    },
    async getCommit(o, r, sha) {
      const c = await request('GET', `${rp(o, r)}/commits/${encodeURIComponent(sha)}`);
      return (c.files || []).map(normalizeFile);
    },
    async getRepo(o, r) {
      const d = await request('GET', rp(o, r));
      return { allowMerge: !!d.allow_merge_commit, allowSquash: !!d.allow_squash_merge, allowRebase: !!d.allow_rebase_merge };
    },
    async mergePull(o, r, n, { method, sha } = {}) {
      if (!sha) throw new Error('mergePull needs the head sha');
      // Sending the head sha makes GitHub refuse (409) if the branch moved since the user looked.
      const d = await request('PUT', `${rp(o, r)}/pulls/${n}/merge`, { merge_method: method, sha });
      return { merged: !!d?.merged, message: d?.message ?? '' };
    },
    // A pull request's conversation is its issue's comments (review comments on lines are a separate list).
    async listComments(o, r, n) {
      return (await paged(`${rp(o, r)}/issues/${n}/comments`, MAX_COMMENTS)).map(normalizeComment);
    },
    async addComment(o, r, n, body) {
      if (typeof body !== 'string' || !body.trim()) throw new Error('addComment needs a body');
      if (body.length > MAX_COMMENT_LEN) throw new Error('That comment is too long for GitHub');
      return normalizeComment(await request('POST', `${rp(o, r)}/issues/${n}/comments`, { body }));
    },
    async closePull(o, r, n) {
      const d = await request('PATCH', `${rp(o, r)}/pulls/${n}`, { state: 'closed' });
      return { closed: d?.state === 'closed' };
    },
  };
}

// GitHub's list endpoint leaves out `mergeable` and `commits`; only the single-pull endpoint has them. Asks for each listed
// pull request (at most `limit` requests at once) and takes those fields from the answer. A pull request whose answer fails
// keeps its list data (so it still reads "checking"); the list itself never fails here. A rate limit or an expired sign-in
// stops the asking (every further request would fail the same way, and use up more of the limit): `partial` says which,
// and is null when every row was asked about.
async function enrichPulls(client, owner, repo, pulls, limit = 6) {
  const out = pulls.slice();
  let next = 0;
  let partial = null;
  const worker = async () => {
    while (next < pulls.length && !partial) {
      const i = next++;
      try {
        const full = await client.getPull(owner, repo, pulls[i].number);
        out[i] = { ...pulls[i], mergeable: full.mergeable, mergeableState: full.mergeableState, ...(full.commits === undefined ? {} : { commits: full.commits }) };
      } catch (e) {
        if (e && (e.code === 'rate-limit' || e.code === 'reauth')) partial = partial || e.code;
        /* otherwise keep the list's data for this one */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, pulls.length) }, worker));
  return { pulls: out, partial };
}

module.exports = { parseGithubRemote, githubClient, GithubError, enrichPulls, MAX_COMMENT_LEN };
