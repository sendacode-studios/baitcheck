#!/usr/bin/env node
/**
 * baitcheck CLI.
 *
 * Exit codes are the point of this interface: drop it in front of an agent's
 * work loop and let the shell decide whether to proceed.
 *
 *   0 LIKELY_LEGIT   1 UNVERIFIED   2 SUSPECT   3 TRAP   64 usage error
 */

import { check } from '../src/index.js';
import { renderTerminal, renderMarkdown, renderJson } from '../src/report.js';

const USAGE = `
baitcheck — score a GitHub bounty issue for AI-agent honeypot risk

USAGE
  baitcheck <target> [options]

TARGET
  owner/repo#123                       an issue
  owner/repo                           repo-level check only
  https://github.com/o/r/issues/123    issue URL

OPTIONS
  --json           machine-readable output
  --markdown, --md  markdown block, for pasting into a PR or report
  --quiet, -q      print only the verdict word
  --no-color       disable ANSI colour
  --shallow        skip contributor and policy-doc lookups (fewer API calls)
  --token <tok>    GitHub token (else $GITHUB_TOKEN, $GH_TOKEN, or \`gh auth token\`)
  --help, -h
  --version, -v

EXIT CODES
  0 likely legit   1 unverified   2 suspect   3 trap   64 usage error

EXAMPLES
  baitcheck facebook/react#31000
  baitcheck someone/etcd#1 --json
  baitcheck owner/repo#5 || echo "not worth the compute"
`;

const VERSION = '0.1.0';

function parseArgs(argv) {
  const opts = {
    target: null,
    json: false,
    markdown: false,
    quiet: false,
    color: undefined,
    deep: true,
    token: undefined,
    help: false,
    version: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--json': opts.json = true; break;
      case '--markdown': case '--md': opts.markdown = true; break;
      case '--quiet': case '-q': opts.quiet = true; break;
      case '--no-color': opts.color = false; break;
      case '--shallow': opts.deep = false; break;
      case '--token': opts.token = argv[++i]; break;
      case '--help': case '-h': opts.help = true; break;
      case '--version': case '-v': opts.version = true; break;
      default:
        if (a.startsWith('-')) throw new Error(`Unknown option: ${a}`);
        if (opts.target) throw new Error(`Unexpected extra argument: ${a}`);
        opts.target = a;
    }
  }
  return opts;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n${USAGE}`);
    process.exit(64);
  }

  if (opts.help) { process.stdout.write(USAGE); return 0; }
  if (opts.version) { process.stdout.write(`${VERSION}\n`); return 0; }
  if (!opts.target) { process.stderr.write(USAGE); process.exit(64); }

  let subject;
  let result;
  try {
    ({ subject, result } = await check(opts.target, {
      token: opts.token,
      deep: opts.deep,
    }));
  } catch (err) {
    process.stderr.write(`baitcheck: ${err.message}\n`);
    process.exit(64);
  }

  if (opts.json) {
    process.stdout.write(`${renderJson(subject, result)}\n`);
  } else if (opts.markdown) {
    process.stdout.write(`${renderMarkdown(subject, result)}\n`);
  } else if (opts.quiet) {
    process.stdout.write(`${result.verdict}\n`);
  } else {
    process.stdout.write(
      `${renderTerminal(subject, result, opts.color === undefined ? {} : { color: opts.color })}\n`,
    );
  }

  return result.exitCode;
}

/**
 * Set `exitCode` and let the loop drain rather than calling `process.exit()`.
 *
 * Exiting eagerly here crashed on Windows: a scan that fails fast (a 404 on the
 * first request) reached `process.exit()` while a fetch socket was still mid
 * close, tripping `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` in
 * libuv. It only ever reproduced on the shortest code path, because longer
 * scans gave the sockets time to settle.
 */
main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`baitcheck: unexpected failure: ${err.stack || err}\n`);
    process.exitCode = 70;
  },
);
