// GitHub pull request client. Pure: it takes a token and a fetch, so tests can fake the network.

const API = 'https://api.github.com';
const MAX_FILES = 3000; // the API itself stops listing a pull request's files here
const MAX_COMMITS = 250;

// Reads owner/repo out of an https, scp-style or ssh GitHub remote. Anything else is null.
function parseGithubRemote(url) {
  const m = /^(?:https?:\/\/|ssh:\/\/git@|git@)github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(String(url || '').trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}

const CODES = { 401: 'reauth', 403: 'forbidden', 404: 'not-found', 405: 'not-mergeable', 409: 'head-changed' };

class GithubError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'GithubError';
    this.code = code;
    this.status = status;
  }
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
    async mergePull(o, r, n, { method, sha }) {
      // Sending the head sha makes GitHub refuse (409) if the branch moved since the user looked.
      const d = await request('PUT', `${rp(o, r)}/pulls/${n}/merge`, { merge_method: method, sha });
      return { merged: !!d?.merged, message: d?.message ?? '' };
    },
  };
}

module.exports = { parseGithubRemote, githubClient, GithubError };
