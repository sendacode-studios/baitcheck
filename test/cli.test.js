/**
 * Process-level tests for the CLI.
 *
 * These exist because the exit-code contract is the product: agents gate on it.
 * A bug that only shows up in process teardown — as one did, a libuv assertion
 * on Windows when `process.exit()` raced a closing fetch socket — is invisible
 * to unit tests of pure functions. It needs a real spawn.
 *
 * Only network-free paths are covered here so `npm test` stays offline and
 * deterministic; the verdict exit codes are exercised against live targets in
 * the README's examples.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/cli.js', import.meta.url));

/** Run the CLI and resolve with its exit code and streams, never rejecting. */
function run(args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { timeout: 20_000 },
      (err, stdout, stderr) => {
        resolve({
          code: err?.code ?? 0,
          killed: Boolean(err?.killed),
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
}

test('--help exits 0 and documents the exit codes', async () => {
  const r = await run(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /EXIT CODES/);
  assert.match(r.stdout, /trap/);
});

test('--version prints a semver-looking string and exits 0', async () => {
  const r = await run(['--version']);
  assert.equal(r.code, 0);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('an unparseable target exits 64, not 1', async () => {
  // 64 is EX_USAGE: a caller gating on "did not clear" must be able to tell a
  // usage mistake from a verdict.
  const r = await run(['garbage']);
  assert.equal(r.code, 64);
});

test('no target at all exits 64 and prints usage to stderr', async () => {
  const r = await run([]);
  assert.equal(r.code, 64);
  assert.match(r.stderr, /USAGE/);
});

test('an unknown option exits 64 rather than being ignored', async () => {
  const r = await run(['owner/repo', '--not-a-real-flag']);
  assert.equal(r.code, 64);
  assert.match(r.stderr, /Unknown option/);
});

test('the process terminates cleanly and is never killed by timeout', async () => {
  // Regression: the CLI used to abort during teardown with a libuv assertion
  // (STATUS_STACK_BUFFER_OVERRUN, 0xC0000409 / -1073740791 on Windows) because
  // it called process.exit() while a socket was closing. Any negative or
  // signal-shaped code here means teardown regressed.
  const r = await run(['garbage']);
  assert.equal(r.killed, false, 'must exit on its own');
  assert.ok(
    Number.isInteger(r.code) && r.code >= 0 && r.code <= 64,
    `expected a documented exit code, got ${r.code}`,
  );
});
