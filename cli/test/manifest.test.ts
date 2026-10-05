import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseManifest, parseEndpoint } from '../src/manifest.js';

function baseIntegration(): Record<string, unknown> {
  return {
    vendor: 'stripe',
    baseline: '2024-01-01',
    endpoints: ['POST /v1/payment_intents'],
  };
}

function manifestWith(integrations: unknown[]): Record<string, unknown> {
  return { version: 1, integrations };
}

test("parseEndpoint('POST /v1/payment_intents') gives { method: 'POST', path: '/v1/payment_intents' }", () => {
  assert.deepEqual(parseEndpoint('POST /v1/payment_intents'), {
    method: 'POST',
    path: '/v1/payment_intents',
  });
});

test("parseEndpoint('  get /repos/{owner}/{repo}  ') uppercases the method and keeps the path template", () => {
  assert.deepEqual(parseEndpoint('  get /repos/{owner}/{repo}  '), {
    method: 'GET',
    path: '/repos/{owner}/{repo}',
  });
});

test("parseEndpoint('FETCH /x') is null, because FETCH is not an HTTP method", () => {
  assert.equal(parseEndpoint('FETCH /x'), null);
});

test("parseEndpoint('/v1/x') is null, because there is no method", () => {
  assert.equal(parseEndpoint('/v1/x'), null);
});

test("parseEndpoint({ method: 'post', path: '/v1/x' }) gives { method: 'POST', path: '/v1/x' }", () => {
  assert.deepEqual(parseEndpoint({ method: 'post', path: '/v1/x' }), {
    method: 'POST',
    path: '/v1/x',
  });
});

test("parseEndpoint({ method: 'POST', path: 'v1/x' }) is null, because a path must start with a slash", () => {
  assert.equal(parseEndpoint({ method: 'POST', path: 'v1/x' }), null);
});

test('parseEndpoint(42) is null', () => {
  assert.equal(parseEndpoint(42), null);
});

test('a manifest with one integration and two endpoints parses: ok is true, one integration, the vendor lower-cased, both endpoints present in order', () => {
  const result = parseManifest(
    manifestWith([
      {
        vendor: 'Stripe',
        baseline: '2024-01-01',
        endpoints: ['POST /v1/payment_intents', 'GET /v1/charges'],
      },
    ]),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.manifest.integrations.length, 1);
  assert.equal(result.manifest.integrations[0]?.vendor, 'stripe');
  assert.deepEqual(result.manifest.integrations[0]?.endpoints, [
    { method: 'POST', path: '/v1/payment_intents' },
    { method: 'GET', path: '/v1/charges' },
  ]);
});

test("a manifest whose version is not 1 fails, and one error mentions '\"version\": 1'", () => {
  const result = parseManifest({ version: 2, integrations: [baseIntegration()] });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((e) => e.includes('"version": 1')));
});

test('a manifest with an empty integrations array fails', () => {
  const result = parseManifest(manifestWith([]));
  assert.equal(result.ok, false);
});

// PROTECTS: a vendor with no endpoints must never produce a clean run.
test("an integration with an empty endpoints array fails, and the error mentions 'endpoints'", () => {
  const result = parseManifest(
    manifestWith([{ vendor: 'stripe', baseline: '2024-01-01', endpoints: [] }]),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((e) => e.includes('endpoints')));
});

test("two integrations naming the same vendor fail, with an error containing 'twice'", () => {
  const result = parseManifest(manifestWith([baseIntegration(), baseIntegration()]));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((e) => e.includes('twice')));
});

test('a duplicate endpoint inside one integration succeeds with exactly one copy kept and exactly one warning', () => {
  const result = parseManifest(
    manifestWith([
      {
        vendor: 'stripe',
        baseline: '2024-01-01',
        endpoints: ['POST /v1/payment_intents', 'POST /v1/payment_intents'],
      },
    ]),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.manifest.integrations[0]?.endpoints.length, 1);
  assert.equal(result.warnings.length, 1);
});

test("a malformed endpoint string fails with an error naming its index, containing 'endpoints[1]'", () => {
  const result = parseManifest(
    manifestWith([
      {
        vendor: 'stripe',
        baseline: '2024-01-01',
        endpoints: ['POST /v1/payment_intents', 'not an endpoint'],
      },
    ]),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((e) => e.includes('endpoints[1]')));
});

test("a vendor given as '  GitHub  ' is normalised to 'github'", () => {
  const result = parseManifest(
    manifestWith([{ vendor: '  GitHub  ', baseline: '2024-01-01', endpoints: ['GET /v1/x'] }]),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.manifest.integrations[0]?.vendor, 'github');
});
