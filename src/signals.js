/**
 * Signal definitions.
 *
 * Every signal is a pure function of the `Subject` snapshot and returns the
 * *evidence* that made it fire, not just a boolean. A security heuristic a
 * human cannot audit is worthless, so the report always shows its reasoning.
 *
 * THE FORGEABILITY RULE
 * ---------------------
 * Only signals that are expensive for an adversary to fake may carry negative
 * (risk-reducing) weight. Stars, account age, repo age, contributor breadth
 * and sustained commit history all cost time or real users. Body text, labels,
 * a committed CONTRIBUTING.md and comments the repo owner writes on their own
 * issue cost nothing — those are recorded as `info` (weight 0) or count
 * *against* the target, never for it.
 *
 * This rule is not theoretical. The first live honeypot this tool was aimed at
 * scored 6/100 "likely legit" because it wrote the word "opire" in the issue
 * body (-12) and replied to its own bait as OWNER (-10). Both were free.
 */

const DAY = 86_400_000;

export function ageInDays(iso, now = Date.now()) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((now - t) / DAY);
}

/** Collect the text an author controls, which is where tells live. */
export function subjectText(subject) {
  const parts = [];
  if (subject.issue?.title) parts.push(subject.issue.title);
  if (subject.issue?.body) parts.push(subject.issue.body);
  const labels = Array.isArray(subject.issue?.labels) ? subject.issue.labels : [];
  for (const l of labels) {
    parts.push(typeof l === 'string' ? l : (l?.name ?? ''));
  }
  if (subject.repo?.description) parts.push(subject.repo.description);
  return parts.join('\n');
}

/**
 * Largest dollar figure being advertised, in USD.
 * Handles `$1,500`, `$1500`, `1500 USD`, `USD 1500`, `/bounty $500`, `$2k`.
 */
export function extractBounty(text) {
  if (!text) return null;
  const found = [];
  const push = (s) => {
    const n = Number(String(s).replace(/[,_\s]/g, ''));
    if (Number.isFinite(n) && n > 0 && n < 1_000_000) found.push(n);
  };
  for (const m of text.matchAll(/\$\s?(\d[\d,_]*(?:\.\d{2})?)\s*([kK])?\b/g)) {
    push(m[2] ? Number(m[1].replace(/[,_]/g, '')) * 1000 : m[1]);
  }
  for (const m of text.matchAll(/\b(\d[\d,_]*)\s?(?:USD|usd)\b/g)) push(m[1]);
  for (const m of text.matchAll(/\b(?:USD|usd)\s?(\d[\d,_]*)\b/g)) push(m[1]);
  return found.length ? Math.max(...found) : null;
}

/** Named payment rails. Informational only — writing one of these is free. */
const RAILS = [
  'algora', 'opire', 'gitcoin', 'polar.sh', 'tip.md', 'thanks.dev',
  'opencollective', 'open collective', 'bountysource', 'issuehunt',
  'stripe', 'github sponsors', 'boss.dev',
];

export function detectRails(text) {
  const lower = (text || '').toLowerCase();
  return RAILS.filter((r) => lower.includes(r));
}

const BOUNTY_WORDS = /\b(bounty|bounties|reward|payout|paid|prize|compensat)/i;

/**
 * Is this issue soliciting paid work at all?
 *
 * Gating the money signals on a *parsed dollar amount* alone was a real gap:
 * plenty of live bounties carry the figure in an embedded widget or a linked
 * platform page, so the text has intent but no number. Intent is the correct
 * trigger; the amount only sets thresholds.
 */
export function hasBountyIntent(subject) {
  const text = subjectText(subject);
  if (extractBounty(text) != null) return true;
  if (detectRails(text).length > 0) return true;
  return BOUNTY_WORDS.test(text);
}

/**
 * Instructions that would execute attacker-controlled code.
 * This is the FakeGit / SmartLoader shape: a plausible README or issue that
 * routes the reader to a payload. Critical, because an agent acting on blind
 * instruction runs it before a human ever reads it.
 */
const EXEC_PATTERNS = [
  { re: /curl\s+[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|)sh/i, what: 'curl | sh' },
  { re: /wget\s+[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|)sh/i, what: 'wget | sh' },
  { re: /\biwr\b[^\n|]*\|\s*iex\b/i, what: 'iwr | iex' },
  { re: /Invoke-WebRequest[^\n|]*\|\s*Invoke-Expression/i, what: 'IWR | IEX' },
  { re: /powershell(?:\.exe)?\s+-(?:e|enc|encodedcommand)\b/i, what: 'encoded PowerShell' },
  { re: /\bbase64\s+-d\b[^\n|]*\|\s*(?:ba|z|)sh/i, what: 'base64 | sh' },
  { re: /https?:\/\/\S+\.(?:exe|msi|scr|bat|ps1|zip|7z|rar)\b/i, what: 'binary/archive download link' },
  { re: /pip\s+install\s+(?:-\S+\s+)*https?:\/\//i, what: 'pip install from URL' },
  { re: /npm\s+(?:i|install)\s+(?:-\S+\s+)*https?:\/\//i, what: 'npm install from URL' },
];

export function detectExecInstructions(text) {
  if (!text) return [];
  return EXEC_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.what);
}

/** Tasks whose real value to the poster is a contribution graph, not the fix. */
const TRIVIAL = /\b(typo|spelling|readme|jsdoc|docstring|whitespace|indentation|formatting|prettier|lint(?:ing)?\s*fix|add\s+a?\s*comment|broken\s+link|rename\s+variable)\b/i;

export function looksTrivial(text) {
  return TRIVIAL.test(text || '');
}

/**
 * Is this repo standing in front of a far more popular project of the same
 * name? Covers both routes: a declared fork, and an *import* that carries no
 * fork flag at all. Out-starring the real project is not free, which is what
 * makes this check resistant to the evasion that broke the fork-only version.
 */
export function impersonationEvidence(s) {
  const mine = s.repo?.stargazers_count ?? 0;

  if (s.repo?.fork && s.parent && (s.parent.stargazers_count ?? 0) >= 200) {
    return { via: 'declared fork', rival: s.parent, mine };
  }

  const rival = s.canonicalRival;
  const rivalStars = rival?.stargazers_count ?? 0;
  if (rival && rivalStars >= 200 && rivalStars >= Math.max(200, mine * 20)) {
    return { via: 'name collision', rival, mine };
  }

  return null;
}

function stars(s) {
  return s.repo?.stargazers_count ?? 0;
}

function pct(n, d) {
  return d > 0 ? Math.round((n / d) * 100) : 0;
}

/**
 * The signal table.
 * `test` returns `{fired:false}` when it cannot conclude — an inconclusive
 * signal must never be scored as reassurance.
 */
export const SIGNALS = [
  // ---------------------------------------------------------------- critical
  {
    id: 'remote-exec-instruction',
    label: 'Issue or repo text instructs running remote code',
    weight: 45,
    severity: 'critical',
    test(s) {
      const hits = detectExecInstructions(subjectText(s));
      if (!hits.length) return { fired: false };
      return {
        fired: true,
        evidence: `matched ${hits.length} execution pattern(s): ${hits.join(', ')}`,
      };
    },
  },
  {
    id: 'impersonates-canonical',
    label: 'Stands in front of a far more popular project of the same name',
    weight: 45,
    severity: 'critical',
    test(s) {
      const eq = impersonationEvidence(s);
      if (!eq) return { fired: false };
      const rivalStars = (eq.rival.stargazers_count ?? 0).toLocaleString('en-US');
      return {
        fired: true,
        evidence:
          `${eq.via}: ${eq.rival.full_name} has ${rivalStars}★ against ` +
          `${eq.mine.toLocaleString('en-US')}★ here — paid work on that project ` +
          `does not originate in this repo`,
      };
    },
  },

  // -------------------------------------------------------------------- high
  {
    id: 'owner-account-fresh',
    label: 'Repo owner account is brand new',
    weight: 30,
    severity: 'high',
    test(s) {
      const age = ageInDays(s.owner?.created_at);
      if (age == null || age >= 180) return { fired: false };
      // Tiered: an account minted today offering money is close to decisive,
      // while six months of history is only mildly interesting.
      const weight = age < 30 ? 30 : age < 90 ? 22 : 14;
      return {
        fired: true,
        weight,
        evidence:
          age === 0
            ? 'owner account was created today'
            : `owner account is ${age} days old`,
      };
    },
  },
  {
    id: 'repo-minted-recently',
    label: 'Repo created moments ago yet already soliciting paid work',
    weight: 20,
    severity: 'high',
    test(s) {
      const age = ageInDays(s.repo?.created_at);
      if (age == null || age > 7) return { fired: false };
      if (!hasBountyIntent(s)) return { fired: false };
      const created = s.repo?.created_at;
      return {
        fired: true,
        evidence:
          age === 0
            ? `repo created today (${created}) and already advertising a bounty`
            : `repo is ${age} days old and already advertising a bounty`,
      };
    },
  },
  {
    id: 'agent-swarm',
    label: 'Comment volume far exceeds the project audience',
    weight: 16,
    severity: 'high',
    test(s) {
      const comments = s.issue?.comments ?? 0;
      if (comments < 20 || comments <= stars(s)) return { fired: false };
      return {
        fired: true,
        evidence:
          `${comments} comments against ${stars(s)}★ — claim traffic without ` +
          `a real user base is the signature of agents piling onto bait`,
      };
    },
  },
  {
    id: 'trivial-task-paid',
    label: 'Money attached to a task with no engineering value',
    weight: 15,
    severity: 'high',
    test(s) {
      if (!hasBountyIntent(s)) return { fired: false };
      if (!looksTrivial(s.issue?.title || '')) return { fired: false };
      const amount = extractBounty(subjectText(s));
      return {
        fired: true,
        evidence: amount
          ? `$${amount} offered for what reads as a cosmetic change`
          : 'paid work advertised for what reads as a cosmetic change',
      };
    },
  },
  {
    id: 'no-payment-rail',
    label: 'No named way for the money to actually reach you',
    weight: 14,
    severity: 'high',
    test(s) {
      if (!s.issue || !hasBountyIntent(s)) return { fired: false };
      if (detectRails(subjectText(s)).length) return { fired: false };
      const amount = extractBounty(subjectText(s));
      return {
        fired: true,
        evidence:
          `${amount ? `$${amount}` : 'payment'} promised with no escrow or ` +
          `payout platform named (looked for ${RAILS.length} known rails)`,
      };
    },
  },
  {
    id: 'zero-traction',
    label: 'Paying repo that nobody uses',
    weight: 14,
    severity: 'high',
    test(s) {
      if (!s.repo || !hasBountyIntent(s)) return { fired: false };
      const f = s.repo.forks_count ?? 0;
      if (stars(s) >= 10 || f >= 5) return { fired: false };
      return { fired: true, evidence: `${stars(s)}★ / ${f} forks` };
    },
  },

  // ------------------------------------------------------------------ medium
  {
    id: 'low-issue-number',
    label: 'One of the first issues ever filed here',
    weight: 10,
    severity: 'medium',
    test(s) {
      if (s.ref.issue == null || s.ref.issue > 5) return { fired: false };
      if (!impersonationEvidence(s) && !hasBountyIntent(s)) {
        return { fired: false };
      }
      return {
        fired: true,
        evidence: `issue #${s.ref.issue} — the tracker exists mainly to host this`,
      };
    },
  },
  {
    id: 'single-author-history',
    label: 'Soliciting outside work with a one-person commit history',
    weight: 10,
    severity: 'medium',
    test(s) {
      if (!Array.isArray(s.contributors) || s.contributors.length !== 1) {
        return { fired: false };
      }
      if (!hasBountyIntent(s)) return { fired: false };
      return { fired: true, evidence: '1 contributor in the entire repo history' };
    },
  },
  {
    id: 'mass-produced-issue',
    label: 'Issue body is thin relative to the money offered',
    weight: 9,
    severity: 'medium',
    test(s) {
      const amount = extractBounty(subjectText(s));
      const len = (s.issue?.body || '').trim().length;
      if (!amount || amount < 250 || len >= 400) return { fired: false };
      return {
        fired: true,
        evidence: `$${amount} specified in ${len} characters of description`,
      };
    },
  },
  {
    id: 'duplicate-claim-text',
    label: 'Commenters posting near-identical claim messages',
    weight: 8,
    severity: 'medium',
    test(s) {
      if (!Array.isArray(s.comments) || s.comments.length < 6) {
        return { fired: false };
      }
      const norm = (t) =>
        (t || '').toLowerCase().replace(/[^a-z\s]/g, '')
          .replace(/\s+/g, ' ').trim().slice(0, 60);
      const counts = new Map();
      for (const c of s.comments) {
        const k = norm(c.body);
        if (k.length < 12) continue;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      const worst = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      if (!worst || worst[1] < 3) return { fired: false };
      return {
        fired: true,
        evidence:
          `${worst[1]} comments share the same opening ` +
          `(${pct(worst[1], s.comments.length)}% of the thread)`,
      };
    },
  },
  {
    id: 'no-maintainer-reply',
    label: 'Busy thread the maintainer has never touched',
    weight: 7,
    severity: 'medium',
    test(s) {
      if (!Array.isArray(s.comments) || s.comments.length < 5) {
        return { fired: false };
      }
      if (countMaintainerComments(s) > 0) return { fired: false };
      return {
        fired: true,
        evidence: `${s.comments.length} comments, none from the owner or a collaborator`,
      };
    },
  },

  // -------------------------------------------------- costly, may reduce risk
  {
    id: 'canonical-established',
    label: 'Canonical repo with real history',
    weight: -25,
    severity: 'positive',
    test(s) {
      if (!s.repo || s.repo.fork) return { fired: false };
      if (impersonationEvidence(s)) return { fired: false };
      const age = ageInDays(s.repo.created_at);
      if (age == null || age < 365 || stars(s) < 500) return { fired: false };
      return {
        fired: true,
        evidence: `not a fork, ${stars(s).toLocaleString('en-US')}★, ${Math.floor(age / 365)}y old`,
      };
    },
  },
  {
    id: 'sustained-activity',
    label: 'Sustained commit activity over time',
    weight: -10,
    severity: 'positive',
    test(s) {
      const pushed = ageInDays(s.repo?.pushed_at);
      const age = ageInDays(s.repo?.created_at);
      if (pushed == null || pushed > 30) return { fired: false };
      if (age == null || age < 180) return { fired: false };
      return { fired: true, evidence: `last push ${pushed}d ago on a ${age}d-old repo` };
    },
  },
  {
    id: 'maintainer-engaged',
    label: 'Established maintainer is present in the thread',
    weight: -10,
    severity: 'positive',
    test(s) {
      const n = countMaintainerComments(s);
      if (!n) return { fired: false };
      // Credit only when the replying identity itself cost something. A
      // day-old account answering its own bait as OWNER is worth nothing.
      const ownerAge = ageInDays(s.owner?.created_at);
      const established = ownerAge != null && ownerAge >= 365 && stars(s) >= 100;
      if (!established) {
        return {
          fired: true,
          weight: 0,
          severity: 'info',
          evidence:
            `${n} owner/collaborator comment(s), but this identity is not ` +
            `established (${ownerAge ?? '?'}d old, ${stars(s)}★) — no credit given`,
        };
      }
      return { fired: true, evidence: `${n} comment(s) from owner/member/collaborator` };
    },
  },

  // -------------------------------------------- free to forge: info only (0)
  {
    id: 'payment-rail-named',
    label: 'Names a payout platform',
    weight: 0,
    severity: 'info',
    test(s) {
      const rails = detectRails(subjectText(s));
      if (!rails.length) return { fired: false };
      return {
        fired: true,
        evidence: `references ${rails.join(', ')} — unverified, anyone can write this`,
      };
    },
  },
  {
    id: 'org-policy-doc',
    label: 'Publishes a contribution or security policy',
    weight: 0,
    severity: 'info',
    test(s) {
      const have = Object.entries(s.docs || {})
        .filter(([, v]) => v)
        .map(([k]) => k.toUpperCase());
      if (!have.length) return { fired: false };
      return {
        fired: true,
        evidence: `repo publishes ${have.join(', ')} — cheap to add, not evidence of intent`,
      };
    },
  },
];

function countMaintainerComments(s) {
  if (!Array.isArray(s.comments) || !s.comments.length) return 0;
  const ownerLogin = s.repo?.owner?.login?.toLowerCase();
  return s.comments.filter(
    (c) =>
      (ownerLogin && c.user?.login?.toLowerCase() === ownerLogin) ||
      c.author_association === 'OWNER' ||
      c.author_association === 'MEMBER' ||
      c.author_association === 'COLLABORATOR',
  ).length;
}

/**
 * Run every signal. Signals that throw are reported, never fatal.
 * A signal may override its own `weight`/`severity` (see owner-account-fresh
 * tiering and the maintainer-engaged downgrade).
 */
export function evaluate(subject) {
  const results = [];
  for (const sig of SIGNALS) {
    let out;
    try {
      out = sig.test(subject);
    } catch (err) {
      results.push({
        id: sig.id,
        label: sig.label,
        weight: 0,
        severity: 'info',
        fired: false,
        errored: true,
        evidence: `signal failed: ${err.message}`,
      });
      continue;
    }
    if (!out?.fired) continue;
    results.push({
      id: sig.id,
      label: sig.label,
      weight: out.weight ?? sig.weight,
      severity: out.severity ?? sig.severity,
      fired: true,
      evidence: out.evidence ?? null,
    });
  }
  return results;
}
