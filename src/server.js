/**
 * Minimal HTTP wrapper around `check()`, so a fleet of agents can share one
 * vetting endpoint instead of each carrying a GitHub token.
 *
 * Uses node:http directly — same zero-dependency constraint as the CLI. An
 * endpoint whose job is to vet supply-chain risk should not drag a web
 * framework and its transitive tree along with it.
 *
 *   GET /healthz
 *   GET /check?target=owner/repo%23123
 *
 * Deliberately omitted: auth, persistence, and rate limiting of its own. Run it
 * on a private network or put a gateway in front. See app.yaml.
 */

import { createServer } from 'node:http';
import { check } from './index.js';
import { recommendation } from './score.js';

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';

/** Cheap in-process cache: agents in a fleet re-check the same targets a lot. */
const cache = new Map();
const TTL_MS = Number(process.env.CACHE_TTL_MS || 10 * 60 * 1000);
const MAX_ENTRIES = 500;

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), value });
}

function send(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

const server = createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return send(res, 400, { error: 'malformed request URL' });
  }

  if (req.method !== 'GET') {
    return send(res, 405, { error: 'only GET is supported' });
  }

  if (url.pathname === '/healthz') {
    return send(res, 200, { ok: true, uptimeSeconds: Math.round(process.uptime()) });
  }

  if (url.pathname !== '/check') {
    return send(res, 404, {
      error: 'not found',
      endpoints: ['/healthz', '/check?target=owner/repo%23123'],
    });
  }

  const target = url.searchParams.get('target');
  if (!target) {
    return send(res, 400, {
      error: 'missing ?target=',
      example: '/check?target=owner%2Frepo%23123',
    });
  }

  const cached = cacheGet(target);
  if (cached) return send(res, 200, { ...cached, cached: true });

  try {
    const { subject, result } = await check(target, { deep: true });
    const body = {
      target: subject.ref,
      title: subject.issue?.title ?? null,
      verdict: result.verdict,
      risk: result.risk,
      exitCode: result.exitCode,
      recommendation: recommendation(result),
      coverage: result.coverage,
      signals: result.signals.map((s) => ({
        id: s.id,
        severity: s.severity,
        weight: s.weight,
        evidence: s.evidence,
      })),
      fetchedAt: subject.fetchedAt,
      cached: false,
    };
    cacheSet(target, body);
    return send(res, 200, body);
  } catch (err) {
    // A parse failure is the caller's problem; anything else is ours.
    const bad = /Cannot parse/.test(err.message);
    return send(res, bad ? 400 : 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`baitcheck listening on http://${HOST}:${PORT}\n`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
