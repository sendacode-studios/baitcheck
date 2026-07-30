/**
 * Apify Actor entry point.
 *
 * This is the only file that imports the `apify` SDK. The scanner in `src/`
 * stays dependency-free and knows nothing about Apify, so the platform adapter
 * is the single place carrying weight — and the core stays auditable by reading
 * it, which is the whole premise of a tool that vets supply-chain risk.
 *
 * Built for Theme 2 of the Apify content program: an Actor an AI agent can
 * reach for on its own. That shapes three decisions here:
 *
 *   1. Every field in input_schema.json is described for a *reader deciding how
 *      to call it*, not for a human filling a form. The schema is the agent's
 *      prompt.
 *   2. Output carries the evidence for each verdict, not just a score. An agent
 *      that has to explain why it skipped a task needs the reason.
 *   3. `Actor.fail()` on a bad verdict, so an agent workflow can branch on run
 *      status without parsing the dataset.
 */

import { Actor } from 'apify';

import { check } from './index.js';
import { recommendation, VERDICT } from './score.js';

/** Verdict severity, so `failOnRisk` can be compared as a threshold. */
const RANK = {
  [VERDICT.LIKELY_LEGIT]: 0,
  [VERDICT.UNVERIFIED]: 1,
  [VERDICT.SUSPECT]: 2,
  [VERDICT.TRAP]: 3,
};

await Actor.init();

const {
  targets = [],
  githubToken,
  failOnRisk = 'TRAP',
  deep = true,
} = (await Actor.getInput()) ?? {};

if (!Array.isArray(targets) || targets.length === 0) {
  await Actor.fail(
    'No targets given. Pass at least one "owner/repo#123", "owner/repo", or github.com issue URL.',
  );
}

// A token is optional by design, but silence about its absence would be
// misleading: without one, most verdicts degrade to UNVERIFIED and the run
// looks inconclusive for a reason the caller never sees.
if (!githubToken) {
  Actor.log.warning(
    'No githubToken supplied. GitHub allows 60 requests/hour anonymously, so ' +
      'checks will likely return UNVERIFIED rather than a conclusive verdict.',
  );
}

const results = [];

for (const target of targets) {
  let record;
  try {
    const { subject, result } = await check(target, { token: githubToken, deep });

    record = {
      target,
      title: subject.issue?.title ?? null,
      url: subject.issue?.html_url ?? subject.repo?.html_url ?? null,
      verdict: result.verdict,
      risk: result.risk,
      recommendation: recommendation(result),
      coverageComplete: result.coverage.complete,
      missing: result.coverage.missing,
      signals: result.signals.map((s) => ({
        id: s.id,
        severity: s.severity,
        weight: s.weight,
        evidence: s.evidence,
      })),
      repo: subject.repo
        ? {
            fullName: subject.repo.full_name,
            fork: subject.repo.fork,
            stars: subject.repo.stargazers_count,
            createdAt: subject.repo.created_at,
            impersonating: subject.canonicalRival?.full_name ?? null,
          }
        : null,
      apiCalls: subject.apiCalls,
      checkedAt: subject.fetchedAt,
    };

    const mark =
      record.verdict === VERDICT.LIKELY_LEGIT ? 'ok' : record.verdict.toLowerCase();
    Actor.log.info(`${mark}: ${target} — ${record.verdict} (risk ${record.risk})`);
    for (const s of record.signals.filter((x) => x.weight > 0)) {
      Actor.log.debug(`  ${s.id}: ${s.evidence}`);
    }
  } catch (err) {
    // One malformed target must not discard the verdicts already gathered.
    Actor.log.error(`could not check ${target}: ${err.message}`);
    record = {
      target,
      verdict: VERDICT.UNVERIFIED,
      risk: null,
      recommendation: `Could not check this target: ${err.message}`,
      error: err.message,
      checkedAt: new Date().toISOString(),
    };
  }

  results.push(record);
  await Actor.pushData(record);
}

const worst = results.reduce(
  (acc, r) => ((RANK[r.verdict] ?? 1) > (RANK[acc] ?? 1) ? r.verdict : acc),
  VERDICT.LIKELY_LEGIT,
);

const summary = {
  checked: results.length,
  worstVerdict: worst,
  counts: results.reduce((acc, r) => {
    acc[r.verdict] = (acc[r.verdict] ?? 0) + 1;
    return acc;
  }, {}),
  cleared: results.filter((r) => r.verdict === VERDICT.LIKELY_LEGIT).map((r) => r.target),
  blocked: results
    .filter((r) => r.verdict === VERDICT.TRAP || r.verdict === VERDICT.SUSPECT)
    .map((r) => r.target),
};

await Actor.setValue('SUMMARY', summary);
Actor.log.info(
  `checked ${summary.checked} target(s); worst verdict ${summary.worstVerdict}`,
);

// Fail the run when the worst verdict crosses the caller's threshold, so an
// agent can branch on run status alone. Reported before failing, so the dataset
// and SUMMARY are always readable either way.
const threshold = RANK[failOnRisk];
if (threshold !== undefined && RANK[worst] >= threshold) {
  await Actor.fail(
    `Worst verdict ${worst} meets the failOnRisk threshold (${failOnRisk}). ` +
      `Blocked: ${summary.blocked.join(', ') || worst}. See the dataset for evidence.`,
  );
}

await Actor.exit();
