/**
 * Survey live GitHub bounty issues and report what fraction are traps.
 *
 * Produces two artefacts in ./data:
 *   survey-<stamp>.json  full per-issue records, for reproduction
 *   survey-<stamp>.md    the aggregate tables
 *
 * Usage:
 *   node scripts/survey.js [--limit 120] [--out data]
 *
 * On sampling: this is a *sample of label-discoverable bounty issues*, not a
 * census of paid open-source work. Issues that never carry a bounty label, and
 * private or invite-only programs, are invisible to it. Every number below is
 * reported against that frame, and the frame is printed in the output so no
 * reader has to guess at it.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { gatherSubject, parseRef, searchBountyIssues } from '../src/github.js';
import { evaluate, extractBounty, subjectText } from '../src/signals.js';
import { score, VERDICT } from '../src/score.js';

/** Several queries, because any single one encodes its own bias. */
const QUERIES = [
  'label:bounty is:issue state:open',
  'label:"💎 Bounty" is:issue state:open',
  'label:"bounty" is:issue state:open sort:updated',
  'bounty in:title is:issue state:open',
  'label:"help wanted" bounty in:body is:issue state:open',
];

function parseArgs(argv) {
  const opts = { limit: 120, out: 'data', concurrency: 3 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit') opts.limit = Number(argv[++i]);
    else if (argv[i] === '--out') opts.out = argv[++i];
    else if (argv[i] === '--concurrency') opts.concurrency = Number(argv[++i]);
  }
  return opts;
}

/** Fixed-size worker pool; keeps us polite to the API and easy to reason about. */
async function pool(items, size, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i], i);
      } catch (err) {
        results[i] = { error: String(err?.message ?? err) };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

function median(nums) {
  const xs = nums.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : Math.round((xs[mid - 1] + xs[mid]) / 2);
}

function pct(n, d) {
  return d > 0 ? Number(((n / d) * 100).toFixed(1)) : 0;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const started = new Date().toISOString();

  process.stderr.write(`discovering issues across ${QUERIES.length} queries...\n`);
  const seen = new Set();
  const targets = [];
  for (const q of QUERIES) {
    const items = await searchBountyIssues(q, { perPage: 100, pages: 1 });
    process.stderr.write(`  ${items.length.toString().padStart(3)}  ${q}\n`);
    for (const it of items) {
      const repoPath = it.repository_url?.replace(
        'https://api.github.com/repos/',
        '',
      );
      if (!repoPath || it.number == null) continue;
      const key = `${repoPath}#${it.number}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ key, repoPath, number: it.number, title: it.title });
    }
  }

  const sample = targets.slice(0, opts.limit);
  process.stderr.write(
    `\n${targets.length} unique issues found; scanning ${sample.length}\n`,
  );

  let done = 0;
  const records = await pool(sample, opts.concurrency, async (t) => {
    const ref = parseRef(`${t.repoPath}#${t.number}`);
    const subject = await gatherSubject(ref, { deep: true });
    const fired = evaluate(subject);
    const result = score(subject, fired);
    const amount = extractBounty(subjectText(subject));

    done++;
    if (done % 10 === 0) {
      process.stderr.write(`  scanned ${done}/${sample.length}\n`);
    }

    return {
      target: t.key,
      title: subject.issue?.title ?? t.title ?? null,
      url: subject.issue?.html_url ?? null,
      verdict: result.verdict,
      risk: result.risk,
      advertisedUsd: amount,
      repo: subject.repo
        ? {
            full_name: subject.repo.full_name,
            fork: subject.repo.fork,
            stars: subject.repo.stargazers_count,
            created_at: subject.repo.created_at,
          }
        : null,
      ownerAgeDays: subject.owner?.created_at
        ? Math.floor(
            (Date.now() - Date.parse(subject.owner.created_at)) / 86_400_000,
          )
        : null,
      canonicalRival: subject.canonicalRival?.full_name ?? null,
      signals: fired.map((f) => ({ id: f.id, weight: f.weight })),
      coverageComplete: result.coverage.complete,
      errors: subject.errors,
    };
  });

  const scanned = records.filter((r) => r && !r.error);
  const n = scanned.length;

  const byVerdict = {};
  for (const v of Object.values(VERDICT)) byVerdict[v] = 0;
  for (const r of scanned) byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1;

  const signalFreq = new Map();
  for (const r of scanned) {
    for (const s of r.signals) {
      signalFreq.set(s.id, (signalFreq.get(s.id) ?? 0) + 1);
    }
  }
  const signalRows = [...signalFreq.entries()].sort((a, b) => b[1] - a[1]);

  const trapish = scanned.filter(
    (r) => r.verdict === VERDICT.TRAP || r.verdict === VERDICT.SUSPECT,
  );
  const legit = scanned.filter((r) => r.verdict === VERDICT.LIKELY_LEGIT);

  const sumUsd = (rs) => rs.reduce((t, r) => t + (r.advertisedUsd ?? 0), 0);
  const totalAdvertised = sumUsd(scanned);
  const legitAdvertised = sumUsd(legit);

  // Per-issue counts alone would be hostage to concentration: one farm posting
  // hundreds of issues would dominate the headline. Collapse to one record per
  // repo (worst verdict wins) so prevalence across distinct actors is visible
  // next to the raw per-issue rate.
  const RANK = {
    [VERDICT.LIKELY_LEGIT]: 0,
    [VERDICT.UNVERIFIED]: 1,
    [VERDICT.SUSPECT]: 2,
    [VERDICT.TRAP]: 3,
  };
  const worstByRepo = new Map();
  for (const r of scanned) {
    const key = r.repo?.full_name ?? r.target.split('#')[0];
    const prev = worstByRepo.get(key);
    if (!prev || RANK[r.verdict] > RANK[prev.verdict]) worstByRepo.set(key, r);
  }
  const repoRecords = [...worstByRepo.values()];
  const byVerdictRepo = {};
  for (const v of Object.values(VERDICT)) byVerdictRepo[v] = 0;
  for (const r of repoRecords) byVerdictRepo[r.verdict]++;

  const issuesPerRepo = new Map();
  for (const r of scanned) {
    const key = r.repo?.full_name ?? r.target.split('#')[0];
    issuesPerRepo.set(key, (issuesPerRepo.get(key) ?? 0) + 1);
  }
  const topRepos = [...issuesPerRepo.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  const summary = {
    started,
    finished: new Date().toISOString(),
    queries: QUERIES,
    uniqueDiscovered: targets.length,
    scanned: n,
    distinctRepos: repoRecords.length,
    topRepos,
    verdictsByRepo: byVerdictRepo,
    verdictByRepoPct: Object.fromEntries(
      Object.entries(byVerdictRepo).map(([k, v]) => [k, pct(v, repoRecords.length)]),
    ),
    trapOrSuspectByRepoPct: pct(
      repoRecords.filter(
        (r) => r.verdict === VERDICT.TRAP || r.verdict === VERDICT.SUSPECT,
      ).length,
      repoRecords.length,
    ),
    verdicts: byVerdict,
    verdictPct: Object.fromEntries(
      Object.entries(byVerdict).map(([k, v]) => [k, pct(v, n)]),
    ),
    trapOrSuspectPct: pct(trapish.length, n),
    impersonators: scanned.filter((r) =>
      r.signals.some((s) => s.id === 'impersonates-canonical'),
    ).length,
    noPaymentRail: scanned.filter((r) =>
      r.signals.some((s) => s.id === 'no-payment-rail'),
    ).length,
    medianOwnerAgeDays: {
      trap: median(
        scanned.filter((r) => r.verdict === VERDICT.TRAP).map((r) => r.ownerAgeDays),
      ),
      legit: median(legit.map((r) => r.ownerAgeDays)),
    },
    advertisedUsd: {
      total: totalAdvertised,
      fromLikelyLegit: legitAdvertised,
      fromLikelyLegitPct: pct(legitAdvertised, totalAdvertised),
    },
    signalFrequency: Object.fromEntries(signalRows),
  };

  const stamp = started.replace(/[:.]/g, '-');
  const outDir = resolve(process.cwd(), opts.out);
  mkdirSync(outDir, { recursive: true });

  const jsonPath = resolve(outDir, `survey-${stamp}.json`);
  writeFileSync(jsonPath, JSON.stringify({ summary, records: scanned }, null, 2));

  const md = renderSummary(summary, signalRows, legit, n);
  const mdPath = resolve(outDir, `survey-${stamp}.md`);
  writeFileSync(mdPath, md);

  process.stdout.write(`${md}\n`);
  process.stderr.write(`\nwrote ${jsonPath}\nwrote ${mdPath}\n`);
}

function renderSummary(s, signalRows, legit, n) {
  const L = [];
  L.push('# baitcheck survey — live GitHub bounty issues');
  L.push('');
  L.push(`Scan window: ${s.started} → ${s.finished}`);
  L.push(`Unique issues discovered: **${s.uniqueDiscovered}**  ·  scanned: **${s.scanned}**`);
  L.push('');
  L.push('## Verdict distribution');
  L.push('');
  L.push('| verdict | count | share |');
  L.push('|---|---:|---:|');
  for (const [v, c] of Object.entries(s.verdicts)) {
    L.push(`| ${v.replace('_', ' ')} | ${c} | ${s.verdictPct[v]}% |`);
  }
  L.push('');
  L.push(`**${s.trapOrSuspectPct}%** of issues scored TRAP or SUSPECT.`);
  L.push('');
  L.push('## Collapsed to one record per repo');
  L.push('');
  L.push(
    `The per-issue rate above is sensitive to concentration: a single farm can ` +
      `post hundreds of issues. Collapsing to **${s.distinctRepos} distinct repos** ` +
      `(worst verdict per repo) gives the prevalence across actors:`,
  );
  L.push('');
  L.push('| verdict | repos | share |');
  L.push('|---|---:|---:|');
  for (const [v, c] of Object.entries(s.verdictsByRepo)) {
    L.push(`| ${v.replace('_', ' ')} | ${c} | ${s.verdictByRepoPct[v]}% |`);
  }
  L.push('');
  L.push(`**${s.trapOrSuspectByRepoPct}%** of distinct repos scored TRAP or SUSPECT.`);
  L.push('');
  L.push('Most prolific posters in the sample:');
  L.push('');
  L.push('| repo | issues in sample |');
  L.push('|---|---:|');
  for (const [repo, count] of s.topRepos) L.push(`| ${repo} | ${count} |`);
  L.push('');
  L.push('## Money on offer');
  L.push('');
  L.push(`| | USD |`);
  L.push('|---|---:|');
  L.push(`| advertised across the sample | $${s.advertisedUsd.total.toLocaleString('en-US')} |`);
  L.push(`| advertised by a verifiable payer | $${s.advertisedUsd.fromLikelyLegit.toLocaleString('en-US')} |`);
  L.push('');
  L.push(
    `Only **${s.advertisedUsd.fromLikelyLegitPct}%** of advertised dollars come ` +
      `from a repo whose provenance and payout evidence hold up.`,
  );
  L.push('');
  L.push('## Owner account age (median)');
  L.push('');
  L.push(`| verdict | median owner account age |`);
  L.push('|---|---:|');
  L.push(`| TRAP | ${fmtDays(s.medianOwnerAgeDays.trap)} |`);
  L.push(`| LIKELY LEGIT | ${fmtDays(s.medianOwnerAgeDays.legit)} |`);
  L.push('');
  L.push('## Signal frequency');
  L.push('');
  L.push('| signal | fired on | share |');
  L.push('|---|---:|---:|');
  for (const [id, count] of signalRows) {
    L.push(`| \`${id}\` | ${count} | ${pct(count, n)}% |`);
  }
  L.push('');
  L.push(`Repos standing in front of a more popular project of the same name: **${s.impersonators}**`);
  L.push(`Issues promising money with no named payout rail: **${s.noPaymentRail}**`);
  L.push('');
  L.push('## Issues that cleared');
  L.push('');
  if (!legit.length) {
    L.push('_None in this sample._');
  } else {
    L.push('| issue | risk | advertised |');
    L.push('|---|---:|---:|');
    for (const r of legit.sort((a, b) => a.risk - b.risk)) {
      const amt = r.advertisedUsd ? `$${r.advertisedUsd.toLocaleString('en-US')}` : '—';
      L.push(`| ${r.target} | ${r.risk} | ${amt} |`);
    }
  }
  L.push('');
  L.push('## Method and limits');
  L.push('');
  L.push('- Sample frame: open issues discoverable through these queries:');
  for (const q of s.queries) L.push(`  - \`${q}\``);
  L.push(
    '- This is a sample of *label-discoverable* bounty issues, not a census of ' +
      'paid open-source work. Programs that do not label issues, and invite-only ' +
      'programs, are outside the frame.',
  );
  L.push(
    '- `LIKELY LEGIT` means provenance and payout evidence held up under the ' +
      'checks in `src/signals.js`. It is not a guarantee of payment.',
  );
  L.push(
    '- `UNVERIFIED` is the fail-closed default: it includes both thin-evidence ' +
      'targets and scans where the API withheld data.',
  );
  L.push('- Reproduce with `node scripts/survey.js --limit ' + s.scanned + '`.');
  L.push('');
  return L.join('\n');
}

function fmtDays(d) {
  if (d == null) return 'n/a';
  if (d < 400) return `${d} days`;
  return `${(d / 365).toFixed(1)} years`;
}

main().catch((err) => {
  process.stderr.write(`survey failed: ${err.stack || err}\n`);
  process.exit(1);
});
