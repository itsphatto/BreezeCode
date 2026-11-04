const test = require('node:test');
const assert = require('node:assert/strict');
const { parseGithubRemote, githubClient, GithubError, enrichPulls } =require('../src/main/github');

// A fake fetch that records every call and answers from a queue of { status, json }.
function fakeFetch(...queue) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (next instanceof Error) throw next;
    const { status = 200, json = null, headers = {} } = next || {};
    const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
    return { status, ok: status >= 200 && status < 300, json: async () => json, headers: { get: name => h[name.toLowerCase()] ?? null } };
  };
  f.calls = calls;
  return f;
}

const samplePull = (over = {}) => ({
  number: 7,
  title: 'Add thing',
  user: { login: 'octo', avatar_url: 'https://a/octo.png' },
  head: { ref: 'feature', label: 'octo:feature', sha: 'abc', repo: { full_name: 'octo/r' } },
  base: { ref: 'main' },
  draft: false,
  mergeable: null,
  mergeable_state: 'unknown',
  html_url: 'https://github.com/o/r/pull/7',
  created_at: '2026-01-02T03:04:05Z',
  ...over,
});

test('parseGithubRemote reads https, scp and ssh remotes', () => {
  const want = { owner: 'itsphatto', repo: 'Project-B' };
  assert.deepEqual(parseGithubRemote('https://github.com/itsphatto/Project-B.git'), want);
  assert.deepEqual(parseGithubRemote('https://github.com/itsphatto/Project-B'), want);
  assert.deepEqual(parseGithubRemote('git@github.com:itsphatto/Project-B.git'), want);
  assert.deepEqual(parseGithubRemote('ssh://git@github.com/itsphatto/Project-B'), want);
  assert.equal(parseGithubRemote('https://gitlab.com/a/b.git'), null);
  assert.equal(parseGithubRemote(''), null);
});

test('listPulls sends the headers and normalizes pull requests', async () => {
  const f = fakeFetch({ json: [samplePull()] });
  const pulls = await githubClient({ token: 'tok', fetch: f }).listPulls('o', 'r', 'main');
  assert.equal(f.calls[0].url, 'https://api.github.com/repos/o/r/pulls?state=open&base=main&per_page=50');
  assert.equal(f.calls[0].init.method, 'GET');
  assert.deepEqual(f.calls[0].init.headers, {
    Authorization: 'Bearer tok',
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Breeze-IDE',
    'X-GitHub-Api-Version': '2022-11-28',
  });
  assert.equal(f.calls[0].init.body, undefined);
  assert.deepEqual(pulls, [{
    number: 7,
    title: 'Add thing',
    author: 'octo',
    avatar: 'https://a/octo.png',
    head: { ref: 'feature', label: 'octo:feature', sha: 'abc', repo: 'octo/r' },
    base: 'main',
    draft: false,
    mergeable: null,
    mergeableState: 'unknown',
    url: 'https://github.com/o/r/pull/7',
    createdAt: '2026-01-02T03:04:05Z',
  }]);
});

test('enrichPulls takes mergeable and commits from getPull, and keeps the list data when getPull fails', async () => {
  const listed = [1, 2].map(n => ({ number: n, title: `t${n}`, mergeable: null, mergeableState: 'unknown' }));
  const client = {
    async getPull(_o, _r, n) {
      if (n === 2) throw new GithubError('nope', 'http', 500);
      return { number: 1, mergeable: false, mergeableState: 'dirty', commits: 3 };
    },
  };
  const { pulls: out, partial } = await enrichPulls(client, 'o', 'r', listed);
  assert.equal(partial, null);
  assert.deepEqual(out[0], { number: 1, title: 't1', mergeable: false, mergeableState: 'dirty', commits: 3 });
  assert.deepEqual(out[1], listed[1]);
  assert.equal(out[1].mergeable, null);
});

test('enrichPulls runs at most 6 getPull calls at once and keeps the list order', async () => {
  const listed = Array.from({ length: 20 }, (_, i) => ({ number: i + 1, mergeable: null, mergeableState: 'unknown' }));
  let running = 0, peak = 0;
  const client = {
    async getPull(_o, _r, n) {
      peak = Math.max(peak, ++running);
      await new Promise(r => setTimeout(r, 5));
      running--;
      return { mergeable: true, mergeableState: 'clean', commits: n };
    },
  };
  const { pulls: out } = await enrichPulls(client, 'o', 'r', listed);
  assert.equal(peak, 6);
  assert.deepEqual(out.map(p => p.number), listed.map(p => p.number));
  assert.ok(out.every(p => p.mergeable === true && p.commits === p.number));
  assert.deepEqual(await enrichPulls(client, 'o', 'r', []), { pulls: [], partial: null });
});

for (const code of ['rate-limit', 'reauth']) {
  test(`enrichPulls stops asking after a ${code} failure and says so`, async () => {
    const listed = Array.from({ length: 10 }, (_, i) => ({ number: i + 1, mergeable: null, mergeableState: 'unknown' }));
    const asked = [];
    const client = {
      async getPull(_o, _r, n) {
        asked.push(n);
        if (n === 1) throw new GithubError('stop', code, code === 'reauth' ? 401 : 403);
        return { mergeable: true, mergeableState: 'clean', commits: 1 };
      },
    };
    const { pulls, partial } = await enrichPulls(client, 'o', 'r', listed, 1); // one at a time, so the stop is exact
    assert.equal(partial, code);
    assert.deepEqual(asked, [1]);
    assert.deepEqual(pulls, listed);
  });
}

test('listPulls copes with a deleted head repository', async () => {
  const f = fakeFetch({ json: [samplePull({ head: { ref: 'feature', label: 'gone:feature', sha: 'abc', repo: null } })] });
  const [pull] = await githubClient({ token: 't', fetch: f }).listPulls('o', 'r', 'main');
  assert.equal(pull.head.repo, null);
  assert.equal(pull.head.label, 'unknown:feature');
});

test('getPull returns the same shape plus the commit count', async () => {
  const f = fakeFetch({ json: samplePull({ commits: 3, mergeable: true, mergeable_state: 'clean' }) });
  const pull = await githubClient({ token: 't', fetch: f }).getPull('o', 'r', 7);
  assert.equal(f.calls[0].url, 'https://api.github.com/repos/o/r/pulls/7');
  assert.equal(pull.commits, 3);
  assert.equal(pull.mergeable, true);
  assert.equal(pull.mergeableState, 'clean');
  assert.equal(pull.author, 'octo');
});

test('pullFiles follows pages until a short one', async () => {
  const file = i => ({ filename: `f${i}.js`, status: 'modified', additions: 1, deletions: 0, patch: '@@' });
  const page1 = Array.from({ length: 100 }, (_, i) => file(i));
  const page2 = Array.from({ length: 3 }, (_, i) => file(100 + i));
  const f = fakeFetch({ json: page1 }, { json: page2 });
  const files = await githubClient({ token: 't', fetch: f }).pullFiles('o', 'r', 7);
  assert.equal(files.length, 103);
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[0].url, /\/pulls\/7\/files\?per_page=100&page=1$/);
  assert.match(f.calls[1].url, /page=2$/);
});

test('pullFiles normalizes renames and missing patches', async () => {
  const f = fakeFetch({ json: [
    { filename: 'new.js', previous_filename: 'old.js', status: 'renamed', additions: 0, deletions: 0 },
    { filename: 'a.js', status: 'added', additions: 4, deletions: 0, patch: '@@ -0,0 +1,4 @@' },
  ] });
  const files = await githubClient({ token: 't', fetch: f }).pullFiles('o', 'r', 7);
  assert.deepEqual(files[0], { path: 'new.js', previous: 'old.js', status: 'renamed', additions: 0, deletions: 0, patch: null });
  assert.equal(files[1].previous, null);
  assert.equal(files[1].patch, '@@ -0,0 +1,4 @@');
});

test('pullFiles stops at 3000 files', async () => {
  const page = Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}`, status: 'added', additions: 1, deletions: 0 }));
  const f = fakeFetch(...Array.from({ length: 40 }, () => ({ json: page })));
  const files = await githubClient({ token: 't', fetch: f }).pullFiles('o', 'r', 7);
  assert.equal(files.length, 3000);
  assert.equal(f.calls.length, 30);
});

test('pullCommits normalizes commits and caps at 250', async () => {
  const commit = i => ({ sha: `s${i}`, commit: { message: `m${i}`, author: { name: 'Octo', date: '2026-01-01T00:00:00Z' } }, author: { avatar_url: 'https://a/o.png' } });
  const page = start => Array.from({ length: 100 }, (_, i) => commit(start + i));
  const f = fakeFetch({ json: page(0) }, { json: page(100) }, { json: page(200) });
  const commits = await githubClient({ token: 't', fetch: f }).pullCommits('o', 'r', 7);
  assert.equal(commits.length, 250);
  assert.equal(f.calls.length, 3);
  assert.match(f.calls[0].url, /\/pulls\/7\/commits\?per_page=100&page=1$/);
  assert.deepEqual(commits[0], { sha: 's0', message: 'm0', author: 'Octo', avatar: 'https://a/o.png', date: '2026-01-01T00:00:00Z' });
});

test('getCommit returns normalized files', async () => {
  const f = fakeFetch({ json: { sha: 'abc', files: [{ filename: 'a.js', status: 'modified', additions: 2, deletions: 1, patch: '@@' }] } });
  const files = await githubClient({ token: 't', fetch: f }).getCommit('o', 'r', 'abc');
  assert.equal(f.calls[0].url, 'https://api.github.com/repos/o/r/commits/abc');
  assert.deepEqual(files, [{ path: 'a.js', previous: null, status: 'modified', additions: 2, deletions: 1, patch: '@@' }]);
});

test('getRepo reports which merge methods are allowed', async () => {
  const f = fakeFetch({ json: { allow_merge_commit: true, allow_squash_merge: false, allow_rebase_merge: true } });
  const repo = await githubClient({ token: 't', fetch: f }).getRepo('o', 'r');
  assert.equal(f.calls[0].url, 'https://api.github.com/repos/o/r');
  assert.deepEqual(repo, { allowMerge: true, allowSquash: false, allowRebase: true });
});

test('errors map to GithubError codes', async () => {
  const cases = [[401, 'reauth'], [403, 'forbidden'], [404, 'not-found'], [405, 'not-mergeable'], [409, 'head-changed'], [500, 'http']];
  for (const [status, code] of cases) {
    const client = githubClient({ token: 't', fetch: fakeFetch({ status, json: { message: 'Head branch was modified' } }) });
    await assert.rejects(client.getRepo('o', 'r'), e => {
      assert.ok(e instanceof GithubError);
      assert.equal(e.code, code);
      assert.equal(e.status, status);
      assert.equal(e.message, 'Head branch was modified');
      return true;
    });
  }
});

test('a 403 with no rate limit left and a 429 map to rate-limit with the reset time', async () => {
  const cases = [
    { status: 403, headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '1767225600' } },
    { status: 429, headers: { 'x-ratelimit-reset': '1767225600' } },
  ];
  for (const c of cases) {
    const client = githubClient({ token: 't', fetch: fakeFetch({ ...c, json: { message: 'API rate limit exceeded' } }) });
    await assert.rejects(client.getRepo('o', 'r'), e => {
      assert.ok(e instanceof GithubError);
      assert.equal(e.code, 'rate-limit');
      assert.equal(e.status, c.status);
      assert.equal(e.resetAt, 1767225600);
      return true;
    });
  }
  // A 403 with requests left is still a permission problem.
  const forbidden = githubClient({ token: 't', fetch: fakeFetch({ status: 403, headers: { 'x-ratelimit-remaining': '42' }, json: { message: 'no' } }) });
  await assert.rejects(forbidden.getRepo('o', 'r'), e => e.code === 'forbidden' && e.resetAt === undefined);
  // A 429 without a reset header still reads as a rate limit.
  const bare = githubClient({ token: 't', fetch: fakeFetch({ status: 429, json: null }) });
  await assert.rejects(bare.getRepo('o', 'r'), e => e.code === 'rate-limit' && e.resetAt === null && e.message.length > 0);
});

test('mergePull refuses to merge without the head sha', async () => {
  const f = fakeFetch({ json: { merged: true } });
  await assert.rejects(githubClient({ token: 't', fetch: f }).mergePull('o', 'r', 7, { method: 'merge' }), /sha/);
  assert.equal(f.calls.length, 0);
});

test('an error without a body still has a message', async () => {
  const client = githubClient({ token: 't', fetch: fakeFetch({ status: 502, json: null }) });
  await assert.rejects(client.getRepo('o', 'r'), e => e.code === 'http' && e.status === 502 && e.message.length > 0);
});

test('a network failure becomes an http error with status 0', async () => {
  const client = githubClient({ token: 't', fetch: fakeFetch(new TypeError('fetch failed')) });
  await assert.rejects(client.getRepo('o', 'r'), e => e instanceof GithubError && e.code === 'http' && e.status === 0);
});

test('mergePull sends the method and head sha', async () => {
  const f = fakeFetch({ json: { merged: true, message: 'Pull Request successfully merged' } });
  const out = await githubClient({ token: 't', fetch: f }).mergePull('o', 'r', 7, { method: 'squash', sha: 'abc' });
  assert.equal(f.calls[0].url, 'https://api.github.com/repos/o/r/pulls/7/merge');
  assert.equal(f.calls[0].init.method, 'PUT');
  assert.equal(f.calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { merge_method: 'squash', sha: 'abc' });
  assert.deepEqual(out, { merged: true, message: 'Pull Request successfully merged' });
});
