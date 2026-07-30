/** Rendering only. No decisions are made in this file. */

import { recommendation, VERDICT } from './score.js';

const COLOR = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  red: '\u001b[31m',
  yellow: '\u001b[33m',
  green: '\u001b[32m',
  cyan: '\u001b[36m',
};

const VERDICT_STYLE = {
  [VERDICT.TRAP]: { color: COLOR.red, glyph: 'TRAP', blurb: 'honeypot indicators present' },
  [VERDICT.SUSPECT]: { color: COLOR.yellow, glyph: 'SUSPECT', blurb: 'payer not verifiable' },
  [VERDICT.UNVERIFIED]: { color: COLOR.cyan, glyph: 'UNVERIFIED', blurb: 'insufficient evidence' },
  [VERDICT.LIKELY_LEGIT]: { color: COLOR.green, glyph: 'LIKELY LEGIT', blurb: 'provenance checks out' },
};

const SEVERITY_MARK = {
  critical: '!!',
  high: '!',
  medium: '~',
  positive: '+',
  info: 'i',
};

function supportsColor(stream = process.stdout) {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(stream.isTTY);
}

function bar(risk, width = 24) {
  const filled = Math.round((risk / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

export function renderTerminal(subject, result, { color = supportsColor() } = {}) {
  const c = (code, s) => (color ? `${code}${s}${COLOR.reset}` : s);
  const style = VERDICT_STYLE[result.verdict];
  const ref = subject.ref;
  const target = ref.issue != null
    ? `${ref.owner}/${ref.repo}#${ref.issue}`
    : `${ref.owner}/${ref.repo}`;

  const lines = [];
  lines.push('');
  lines.push(`  ${c(COLOR.bold, 'baitcheck')} ${c(COLOR.dim, target)}`);
  if (subject.issue?.title) {
    lines.push(`  ${c(COLOR.dim, truncate(subject.issue.title, 68))}`);
  }
  lines.push('');
  lines.push(
    `  ${c(style.color, c(COLOR.bold, style.glyph))}  ` +
      `${c(COLOR.dim, bar(result.risk))} ${c(COLOR.bold, `${result.risk}`)}` +
      `${c(COLOR.dim, '/100 risk')}`,
  );
  lines.push(`  ${c(COLOR.dim, style.blurb)}`);
  lines.push('');

  if (result.signals.length === 0) {
    lines.push(`  ${c(COLOR.dim, 'No signals fired.')}`);
  } else {
    for (const s of orderSignals(result.signals)) {
      const mark = SEVERITY_MARK[s.severity] ?? '?';
      const tint =
        s.severity === 'critical' || s.severity === 'high'
          ? COLOR.red
          : s.severity === 'medium'
            ? COLOR.yellow
            : s.severity === 'info'
              ? COLOR.dim
              : COLOR.green;
      const weight = s.weight > 0 ? `+${s.weight}` : `${s.weight}`;
      lines.push(`  ${c(tint, mark.padEnd(2))} ${s.label} ${c(COLOR.dim, `(${weight})`)}`);
      if (s.evidence) lines.push(`     ${c(COLOR.dim, s.evidence)}`);
    }
  }

  lines.push('');
  lines.push(`  ${c(COLOR.bold, '→')} ${recommendation(result)}`);

  if (!result.coverage.complete) {
    lines.push(
      `  ${c(COLOR.dim, `gaps: ${result.coverage.missing.join('; ')}`)}`,
    );
  }
  lines.push(
    `  ${c(COLOR.dim, `${subject.apiCalls} API calls · scanned ${subject.fetchedAt}`)}`,
  );
  lines.push('');
  return lines.join('\n');
}

export function renderMarkdown(subject, result) {
  const ref = subject.ref;
  const target = ref.issue != null
    ? `${ref.owner}/${ref.repo}#${ref.issue}`
    : `${ref.owner}/${ref.repo}`;

  const out = [];
  out.push(`### baitcheck — \`${target}\``);
  if (subject.issue?.title) out.push(`> ${subject.issue.title}`);
  out.push('');
  out.push(`**${result.verdict.replace('_', ' ')}** — risk ${result.risk}/100`);
  out.push('');
  out.push(`${recommendation(result)}`);
  out.push('');
  if (result.signals.length) {
    out.push('| | signal | weight | evidence |');
    out.push('|---|---|---|---|');
    for (const s of orderSignals(result.signals)) {
      const mark = SEVERITY_MARK[s.severity] ?? '?';
      const w = s.weight > 0 ? `+${s.weight}` : `${s.weight}`;
      out.push(`| \`${mark}\` | ${s.label} | ${w} | ${s.evidence ?? ''} |`);
    }
    out.push('');
  }
  if (!result.coverage.complete) {
    out.push(`_Unverified: ${result.coverage.missing.join('; ')}._`);
    out.push('');
  }
  return out.join('\n');
}

export function renderJson(subject, result) {
  return JSON.stringify(
    {
      target: subject.ref,
      title: subject.issue?.title ?? null,
      verdict: result.verdict,
      risk: result.risk,
      recommendation: recommendation(result),
      coverage: result.coverage,
      counts: result.counts,
      signals: result.signals.map((s) => ({
        id: s.id,
        severity: s.severity,
        weight: s.weight,
        evidence: s.evidence,
      })),
      repo: subject.repo
        ? {
            full_name: subject.repo.full_name,
            fork: subject.repo.fork,
            parent: subject.parent?.full_name ?? null,
            stars: subject.repo.stargazers_count,
            created_at: subject.repo.created_at,
          }
        : null,
      fetchedAt: subject.fetchedAt,
      apiCalls: subject.apiCalls,
      errors: subject.errors,
    },
    null,
    2,
  );
}

const ORDER = { critical: 0, high: 1, medium: 2, positive: 3, info: 4 };
function orderSignals(signals) {
  return [...signals].sort(
    (a, b) => (ORDER[a.severity] ?? 9) - (ORDER[b.severity] ?? 9) || b.weight - a.weight,
  );
}

function truncate(s, n) {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
