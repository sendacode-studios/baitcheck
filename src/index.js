/** Programmatic entry point. `check()` is the whole public API. */

import { gatherSubject, parseRef, searchBountyIssues, resolveToken } from './github.js';
import { evaluate } from './signals.js';
import { score, recommendation, VERDICT, EXIT_CODE } from './score.js';
import { renderTerminal, renderMarkdown, renderJson } from './report.js';

/**
 * Scan one target.
 * @param {string} target `owner/repo#123`, `owner/repo`, or an issue URL.
 * @returns {Promise<{subject: object, result: object}>}
 */
export async function check(target, options = {}) {
  const ref = parseRef(target);
  const subject = await gatherSubject(ref, options);
  const fired = evaluate(subject);
  const result = score(subject, fired);
  return { subject, result };
}

export {
  parseRef,
  gatherSubject,
  searchBountyIssues,
  resolveToken,
  evaluate,
  score,
  recommendation,
  renderTerminal,
  renderMarkdown,
  renderJson,
  VERDICT,
  EXIT_CODE,
};
