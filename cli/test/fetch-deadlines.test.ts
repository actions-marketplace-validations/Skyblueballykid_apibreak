/**
 * The deadlines added in 0.1.1: a server that accepts the connection and then
 * stalls used to hang the check for ever, because none of the four network
 * calls set an AbortSignal.
 *
 * These tests run against a real `node:http` server on loopback with small
 * deadlines (150 ms stall, 1000–2000 ms total), and the injected `fetch`
 * rewrites every URL to that server while keeping the original path so the
 * handler can route the commit-listing, commit-meta and raw-spec requests
 * differently. Timing assertions are generous upper bounds — the point is
 * "returns at all", not "returns in exactly 150 ms" — because a slow CI
 * machine must not turn a deadline test into a flake.
 *
 * cli.ts is imported here too; importing it must not run `main` (that is
 * bin.ts's job), which is itself part of what makes githubTokenFrom testable.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { fetchSpec, resolveHead, resolveRevision, type FetchDeps } from '../src/fetch.js';
import { runRadar } from '../src/run.js';
import { exitCode } from '../src/report.js';
import { parseManifest } from '../src/manifest.js';
import { VENDORS } from '../src/vendors.js';
import { githubTokenFrom } from '../src/cli.js';

// Record access types as possibly undefined; assert the registry has this entry.
const stripeSource = VENDORS.stripe;
assert.ok(stripeSource, 'the stripe vendor is registered');

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

interface Server {
  base: string;
  close: () => Promise<void>;
}

/**
 * A real server on an ephemeral port. `close` also destroys any socket the
 * handler left open (the stalling ones all do), otherwise the test process
 * would hang on exit waiting for them.
 */
async function startServer(handler: Handler): Promise<Server> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const close = async (): Promise<void> => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  after(close);
  return { base: `http://127.0.0.1:${port}`, close };
}

/** Rewrites every URL onto the test server, keeping the path for routing. */
function makeFetch(base: string): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const target = new URL(url);
    return fetch(new URL(target.pathname + target.search, base), init);
  }) as typeof fetch;
}

const deps = (server: Server, deadlines: { stallMs: number; totalMs: number }): FetchDeps => ({
  fetch: makeFetch(server.base),
  now: () => new Date(),
  deadlines,
});

const SMALL = { stallMs: 150, totalMs: 1000 };

/** The commit listing and commit-meta endpoints, answering with one commit. */
function commitListing(): Handler {
  return (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('[{"sha":"abc1234def","commit":{"author":{"date":"2025-08-01T00:00:00Z"}}}]');
  };
}

test('resolveHead: server accepts the connection and never sends headers', async () => {
  const server = await startServer(() => {
    // Accept and hold: the socket stays open, nothing is ever written.
  });
  const started = Date.now();
  const head = await resolveHead(stripeSource, deps(server, SMALL));
  const elapsed = Date.now() - started;

  assert.ok(head.unresolved, 'expected an unresolved revision');
  assert.match(head.unresolved, /no response from .* for 150 ms/);
  assert.ok(elapsed < 1000, `resolveHead took ${elapsed} ms; the stall deadline did not bound it`);
});

test('fetchSpec: headers sent, body stalls after the first chunk', async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"info":');
    // Never ends; the stall timer re-armed by the chunk must cut it off.
  });
  const started = Date.now();
  const result = await fetchSpec(
    stripeSource,
    { ref: 'abc1234', stamp: { commit: 'abc1234' } },
    deps(server, SMALL)
  );

  assert.ok(!('raw' in result), 'expected an error');
  assert.match(result.error, /no response from .* for 150 ms/);
  assert.ok(Date.now() - started < 1000);
});

test('fetchSpec: a body that trickles but keeps moving is not cut off', async () => {
  const server = await startServer((_req, res) => {
    // One chunk every 50 ms — well inside the 150 ms stall — for ~650 ms.
    // The version string arrives one character per chunk, so the assertion
    // also proves the chunks are concatenated in order.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"info":{"version":"');
    const word = 'tricklingalong';
    let n = 0;
    const timer = setInterval(() => {
      n += 1;
      if (n > word.length) {
        clearInterval(timer);
        res.end('"}}');
      } else {
        res.write(word[n - 1]);
      }
    }, 50);
    res.on('close', () => clearInterval(timer));
  });
  const result = await fetchSpec(
    stripeSource,
    { ref: 'abc1234def', stamp: { commit: 'abc1234def' } },
    deps(server, { stallMs: 150, totalMs: 2000 })
  );

  assert.ok('raw' in result, `expected success, got ${(result as { error: string }).error}`);
  assert.equal(result.stamp.version, 'tricklingalong');
});

test('fetchSpec: headers restart the stall clock, so a slow first byte after late headers passes', async () => {
  // Headers at ~250 ms and the body ~250 ms after them: each gap is inside the
  // 400 ms stall deadline, their sum is not. Found by the 2026-09-26 Codex review.
  // 150 ms margins: 50 ms flaked on a loaded CI runner (2026-09-28).
  const server = await startServer((_req, res) => {
    const timers: NodeJS.Timeout[] = [];
    timers.push(
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.flushHeaders();
        timers.push(setTimeout(() => res.end('{"info":{"version":"late"}}'), 250));
      }, 250)
    );
    res.on('close', () => timers.forEach(clearTimeout));
  });
  const result = await fetchSpec(
    stripeSource,
    { ref: 'abc1234def', stamp: { commit: 'abc1234def' } },
    deps(server, { stallMs: 400, totalMs: 2000 })
  );

  assert.ok('raw' in result, `expected success, got ${(result as { error: string }).error}`);
  assert.equal(result.stamp.version, 'late');
});

test('fetchSpec: the same trickle is cut off by the total ceiling', async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"info":{"version":"');
    let n = 0;
    const timer = setInterval(() => {
      n += 1;
      if (n >= 30) {
        clearInterval(timer);
        res.end('late"}}');
      } else {
        res.write('x');
      }
    }, 50);
    res.on('close', () => clearInterval(timer));
  });
  const started = Date.now();
  const result = await fetchSpec(
    stripeSource,
    { ref: 'abc1234def', stamp: { commit: 'abc1234def' } },
    deps(server, { stallMs: 150, totalMs: 300 })
  );

  assert.ok(!('raw' in result), 'expected the total ceiling to fire');
  assert.match(result.error, /did not finish within 300 ms/);
  assert.ok(Date.now() - started < 2000);
});

test('resolveRevision: date baseline against a stalling server returns an error, bounded', async () => {
  const server = await startServer(() => {});
  const started = Date.now();
  const result = await resolveRevision(stripeSource, '2025-08-19', deps(server, SMALL));

  assert.ok('error' in result, 'expected an error');
  assert.match(result.error, /no response from/);
  assert.ok(Date.now() - started < 1000);
});

test('resolveRevision: sha baseline tolerates a stalling commit-meta call', async () => {
  const server = await startServer(() => {
    // commit-meta is the only call a sha baseline makes; let it stall.
  });
  const started = Date.now();
  const revision = await resolveRevision(stripeSource, 'abc1234def', deps(server, SMALL));

  assert.ok(!('error' in revision), 'a sha baseline needs no listing, so it must resolve');
  assert.equal(revision.ref, 'abc1234def');
  assert.equal(revision.stamp.commit, 'abc1234def');
  assert.equal(revision.stamp.date, undefined);
  assert.ok(Date.now() - started < 1000);
});

test('runRadar: a spec download that stalls becomes an unknown finding that fails the run', async () => {
  // Route by path: the GitHub listing works, the raw spec download stalls.
  const server = await startServer((req, res) => {
    if (req.url && req.url.startsWith('/repos/')) {
      commitListing()(req, res);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"info":');
  });
  const parsed = parseManifest({
    version: 1,
    integrations: [
      { vendor: 'stripe', baseline: '2025-08-19', endpoints: ['POST /v1/checkout/sessions'] },
    ],
  });
  assert.ok(parsed.ok);
  const report = await runRadar(parsed.manifest, deps(server, SMALL));

  const unknown = report.findings.filter((f) => f.severity === 'unknown');
  assert.ok(unknown.length > 0, `expected an unknown finding, got ${JSON.stringify(report.findings)}`);
  const finding = unknown[0];
  assert.ok(finding, 'expected at least one unknown finding');
  assert.match(finding.detail, /no response from/);
  assert.notEqual(exitCode(report, 'breaking'), 0);
  assert.equal(exitCode(report, 'never'), 0);
});

test('a multibyte character split across two chunks round-trips', async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    // € is three bytes (e2 82 ac): split after the first, and pause between
    // the writes so the two halves arrive as separate body chunks.
    const body = Buffer.from('{"info":{"version":"€"}}', 'utf8');
    const split = body.indexOf(Buffer.from('e2', 'hex')) + 1;
    res.write(body.subarray(0, split));
    const timer = setTimeout(() => res.end(body.subarray(split)), 40);
    res.on('close', () => clearTimeout(timer));
  });
  const result = await fetchSpec(
    stripeSource,
    { ref: 'abc1234def', stamp: { commit: 'abc1234def' } },
    deps(server, SMALL)
  );

  assert.ok('raw' in result, `expected success, got ${(result as { error: string }).error}`);
  assert.equal(result.stamp.version, '€');
});

test('githubTokenFrom reads only APIBREAK_GITHUB_TOKEN', () => {
  // Next.js's env augmentation requires NODE_ENV on the type; these literals
  // are plain environment snapshots, so cast rather than fabricate one.
  const env = (vars: Record<string, string>): NodeJS.ProcessEnv => vars as NodeJS.ProcessEnv;

  // Only our own name: the token is passed through, trimmed.
  assert.deepEqual(githubTokenFrom(env({ APIBREAK_GITHUB_TOKEN: ' tok ' })), { token: 'tok' });

  // A GITHUB_TOKEN exported for some other tool is refused, with a warning.
  const gh = githubTokenFrom(env({ GITHUB_TOKEN: 'secret-gh' }));
  assert.equal(gh.token, undefined);
  assert.match(gh.warning ?? '', /^GITHUB_TOKEN is set but not used;/);
  assert.match(gh.warning ?? '', /APIBREAK_GITHUB_TOKEN/);
  assert.ok(!gh.warning?.includes('secret-gh'), 'the warning must never echo the token value');

  const radar = githubTokenFrom(env({ RADAR_GITHUB_TOKEN: 'secret-radar' }));
  assert.equal(radar.token, undefined);
  assert.match(radar.warning ?? '', /^RADAR_GITHUB_TOKEN is set but not used;/);
  assert.ok(!radar.warning?.includes('secret-radar'));

  const both = githubTokenFrom(env({ GITHUB_TOKEN: 'a', RADAR_GITHUB_TOKEN: 'b' }));
  assert.match(both.warning ?? '', /^GITHUB_TOKEN and RADAR_GITHUB_TOKEN are set but not used;/);

  // The right name wins even alongside legacy names, and then there is no warning.
  const bothWithOurs = githubTokenFrom(env({ APIBREAK_GITHUB_TOKEN: 'tok', GITHUB_TOKEN: 'a' }));
  assert.deepEqual(bothWithOurs, { token: 'tok' });

  // Whitespace-only is as good as unset, and names nothing to warn about.
  assert.deepEqual(githubTokenFrom(env({ APIBREAK_GITHUB_TOKEN: '   ' })), {});
  assert.deepEqual(githubTokenFrom(env({})), {});
});
