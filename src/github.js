/**
 * The only module in baitcheck that touches the network.
 *
 * Everything else operates on the plain `Subject` object returned by
 * `gatherSubject()`. That split is deliberate: signal logic stays pure and
 * testable offline, and there is exactly one place to audit for network
 * behaviour in a tool whose whole job is to be trustworthy.
 */

import { execFileSync } from 'node:child_process';

const API = 'https://api.github.com';
const UA = 'baitcheck/0.1.0';

/**
 * GitHub's search endpoints allow ~30 requests/minute, an order of magnitude
 * tighter than the 5,000/hour core budget. Serialising search calls with a
 * minimum spacing keeps bulk scans from tripping the limit and silently
 * degrading every provenance check to "unverified".
 */
const SEARCH_MIN_INTERVAL_MS = 2100;
let lastSearchAt = 0;
let searchChain = Promise.resolve();

function throttleSearch() {
  searchChain = searchChain.then(async () => {
    const wait = Math.max(0, SEARCH_MIN_INTERVAL_MS - (Date.now() - lastSearchAt));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastSearchAt = Date.now();
  });
  return searchChain;
}

/**
 * Resolve a GitHub token without ever prompting or storing one.
 * Order: explicit arg -> GITHUB_TOKEN / GH_TOKEN -> `gh auth token`.
 * Returns null when nothing is available; callers degrade to the 60 req/hr
 * anonymous budget rather than failing outright.
 */
export function resolveToken(explicit) {
  if (explicit) return explicit;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  try {
    // No `shell: true` here on purpose: passing args through a shell would
    // concatenate rather than escape them (Node DEP0190). `gh` resolves fine
    // as a direct executable, including gh.exe on Windows.
    const bin = process.platform === 'win32' ? 'gh.exe' : 'gh';
    const out = execFileSync(bin, ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const token = out.trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/** Parse `owner/repo#123`, a full issue URL, or `owner/repo` (no issue). */
export function parseRef(input) {
  const raw = String(input || '').trim();

  const url = raw.match(
    /github\.com\/([^/\s]+)\/([^/\s]+)\/(?:issues|pull)\/(\d+)/i,
  );
  if (url) return { owner: url[1], repo: url[2], issue: Number(url[3]) };

  const hash = raw.match(/^([^/\s#]+)\/([^/\s#]+)#(\d+)$/);
  if (hash) return { owner: hash[1], repo: hash[2], issue: Number(hash[3]) };

  const repoOnly = raw.match(/^([^/\s#]+)\/([^/\s#]+)$/);
  if (repoOnly) return { owner: repoOnly[1], repo: repoOnly[2], issue: null };

  throw new Error(
    `Cannot parse "${raw}". Expected owner/repo#123, owner/repo, or a github.com issue URL.`,
  );
}

class Client {
  constructor(token) {
    this.token = token;
    this.calls = 0;
    /** Populated on 403/429 so callers can report *why* data is missing. */
    this.rateLimited = false;
  }

  headers() {
    const h = {
      Accept: 'application/vnd.github+json',
      'User-Agent': UA,
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  /**
   * Fetch JSON, returning `{ ok, data, status, message }` instead of throwing.
   * A missing resource is a *finding* here, not an exception — a deleted repo
   * or hidden owner is itself signal, and must not abort the whole scan.
   */
  async get(path, { raw = false } = {}) {
    this.calls++;
    if (path.includes('/search/')) await throttleSearch();
    let res;
    try {
      res = await fetch(path.startsWith('http') ? path : `${API}${path}`, {
        headers: raw
          ? { ...this.headers(), Accept: 'application/vnd.github.raw' }
          : this.headers(),
      });
    } catch (err) {
      return { ok: false, status: 0, message: `network: ${err.message}` };
    }

    if (res.status === 403 || res.status === 429) {
      const remaining = res.headers.get('x-ratelimit-remaining');
      if (remaining === '0') this.rateLimited = true;
      return { ok: false, status: res.status, message: 'rate limited or forbidden' };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, message: `HTTP ${res.status}` };
    }

    const data = raw ? await res.text() : await res.json();
    return { ok: true, status: res.status, data };
  }
}

/**
 * Find the most popular repo that shares this repo's name.
 *
 * Exists because `fork: false` does not mean "original". An attacker who
 * *imports* a famous project instead of forking it gets an identical-looking
 * repo with no fork badge and no `parent` link — which is precisely how the
 * first honeypot this tool was pointed at evaded detection. Name collision
 * against a far more popular project is the provenance check that survives
 * that evasion, because out-starring the real project is not free.
 */
async function findCanonicalRival(client, owner, repo) {
  const r = await client.get(
    `/search/repositories?q=${encodeURIComponent(`${repo} in:name`)}` +
      `&sort=stars&order=desc&per_page=5`,
  );
  if (!r.ok) return { rival: null, error: r };

  const wanted = repo.toLowerCase();
  const self = `${owner}/${repo}`.toLowerCase();
  for (const item of r.data.items ?? []) {
    if (item.name?.toLowerCase() !== wanted) continue;
    if (item.full_name?.toLowerCase() === self) continue;
    return {
      rival: {
        full_name: item.full_name,
        stargazers_count: item.stargazers_count ?? 0,
        html_url: item.html_url,
      },
      error: null,
    };
  }
  return { rival: null, error: null };
}

/** Does a path exist in the repo? Used for policy-doc signals. */
async function hasPath(client, owner, repo, path) {
  const r = await client.get(
    `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`,
  );
  return r.ok;
}

/**
 * Collect every fact the signals need, in one pass.
 *
 * Never throws for remote problems. Anything that could not be established is
 * left `null` and recorded in `errors`, so scoring can fail toward "unknown"
 * instead of silently toward "safe".
 */
export async function gatherSubject(ref, { token, deep = true } = {}) {
  const client = new Client(resolveToken(token));
  const errors = [];
  const note = (what, r) =>
    errors.push({ what, status: r.status, message: r.message });

  const subject = {
    ref,
    repo: null,
    owner: null,
    issue: null,
    comments: null,
    contributors: null,
    parent: null,
    canonicalRival: null,
    docs: { contributing: false, security: false, bounty: false },
    priorBounties: null,
    fetchedAt: new Date().toISOString(),
    errors,
    apiCalls: 0,
    rateLimited: false,
  };

  const repoRes = await client.get(`/repos/${ref.owner}/${ref.repo}`);
  if (repoRes.ok) subject.repo = repoRes.data;
  else note('repo', repoRes);

  if (subject.repo?.owner?.login) {
    const ownerRes = await client.get(`/users/${subject.repo.owner.login}`);
    if (ownerRes.ok) subject.owner = ownerRes.data;
    else note('owner', ownerRes);
  }

  // `parent` on a fork tells us what the repo is standing in front of. This is
  // the single highest-value fact for spotting a clone of a famous project.
  if (subject.repo?.fork) {
    if (subject.repo.parent) {
      subject.parent = subject.repo.parent;
    } else {
      const p = await client.get(`/repos/${ref.owner}/${ref.repo}`);
      if (p.ok && p.data.parent) subject.parent = p.data.parent;
    }
  }

  if (ref.issue != null) {
    const issueRes = await client.get(
      `/repos/${ref.owner}/${ref.repo}/issues/${ref.issue}`,
    );
    if (issueRes.ok) subject.issue = issueRes.data;
    else note('issue', issueRes);

    if (subject.issue) {
      const cRes = await client.get(
        `/repos/${ref.owner}/${ref.repo}/issues/${ref.issue}/comments?per_page=100`,
      );
      if (cRes.ok) subject.comments = cRes.data;
      else note('comments', cRes);
    }
  }

  if (deep && subject.repo) {
    const contribRes = await client.get(
      `/repos/${ref.owner}/${ref.repo}/contributors?per_page=100&anon=1`,
    );
    if (contribRes.ok) subject.contributors = contribRes.data;
    else note('contributors', contribRes);

    const [contributing, security, bounty] = await Promise.all([
      hasPath(client, ref.owner, ref.repo, 'CONTRIBUTING.md'),
      hasPath(client, ref.owner, ref.repo, 'SECURITY.md'),
      hasPath(client, ref.owner, ref.repo, 'BOUNTY.md'),
    ]);
    subject.docs = { contributing, security, bounty };

    // Only worth asking when this repo has no audience of its own; an
    // established project sharing a common word in its name is not a finding.
    if ((subject.repo.stargazers_count ?? 0) < 500) {
      const { rival, error } = await findCanonicalRival(
        client,
        ref.owner,
        ref.repo,
      );
      subject.canonicalRival = rival;
      if (error) note('canonical-rival-search', error);
    }
  }

  subject.apiCalls = client.calls;
  subject.rateLimited = client.rateLimited;
  return subject;
}

/**
 * Search live issues carrying a bounty-ish label. Used by scripts/survey.js to
 * build a sample; kept here so the network layer stays in one file.
 */
export async function searchBountyIssues(
  query,
  { token, perPage = 100, pages = 1 } = {},
) {
  const client = new Client(resolveToken(token));
  const items = [];
  for (let page = 1; page <= pages; page++) {
    const r = await client.get(
      `/search/issues?q=${encodeURIComponent(query)}` +
        `&sort=created&order=desc&per_page=${perPage}&page=${page}`,
    );
    if (!r.ok) break;
    items.push(...(r.data.items || []));
    if ((r.data.items || []).length < perPage) break;
  }
  return items;
}
