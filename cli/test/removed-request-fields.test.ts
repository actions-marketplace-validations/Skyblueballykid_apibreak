import { test } from 'node:test';
import assert from 'node:assert/strict';
import { removedRequestFields } from '../src/diff.js';
import { indexSpec } from '../src/spec.js';

/**
 * `removedRequestFields` is the request-body half of `diffEndpoints`'s
 * `request_field_removed` rule, pulled out standalone for
 * `scripts/snapshot.ts` (see `radar/src/diff.ts` for why). These tests check
 * it against the same fixture shapes `radar/tests/diff.test.ts` uses for
 * `request_field_removed`, plus the media-type dimension that motivated
 * pulling it out: Stripe's request bodies are
 * `application/x-www-form-urlencoded`, not JSON.
 */

const PATH = '/v1/things';
const METHOD = 'post';
const ENDPOINT = 'POST /v1/things';

function doc(op: Record<string, unknown>): unknown {
  return {
    openapi: '3.0.0',
    info: { title: 't', version: 'v' },
    paths: { [PATH]: { [METHOD]: op } },
  };
}

function opWithBody(schema: unknown, contentType = 'application/json'): Record<string, unknown> {
  return {
    requestBody: { required: true, content: { [contentType]: { schema } } },
    responses: {},
  };
}

function diffed(beforeOp: Record<string, unknown>, afterOp: Record<string, unknown>) {
  return removedRequestFields(indexSpec(doc(beforeOp)), indexSpec(doc(afterOp)));
}

test('a JSON request field removed from the current schema is reported, media type named', () => {
  const before = opWithBody({
    type: 'object',
    properties: { a: { type: 'string' }, b: { type: 'string' } },
  });
  const after = opWithBody({ type: 'object', properties: { a: { type: 'string' } } });
  assert.deepEqual(diffed(before, after), [{ endpoint: ENDPOINT, field: 'b', media: 'application/json' }]);
});

test('a form-urlencoded request field removed from the current schema is reported — the case JSON-only comparison misses', () => {
  const before = opWithBody(
    { type: 'object', properties: { payment_method_types: { type: 'array', items: { type: 'string' } } } },
    'application/x-www-form-urlencoded'
  );
  const after = opWithBody({ type: 'object', properties: {} }, 'application/x-www-form-urlencoded');
  assert.deepEqual(diffed(before, after), [
    { endpoint: ENDPOINT, field: 'payment_method_types', media: 'application/x-www-form-urlencoded' },
  ]);
});

test('a removed parent object is reported once, not once per nested field', () => {
  const before = opWithBody({
    type: 'object',
    properties: {
      coupon: {
        type: 'object',
        properties: { code: { type: 'string' }, percent_off: { type: 'number' } },
      },
    },
  });
  const after = opWithBody({ type: 'object', properties: {} });
  assert.deepEqual(diffed(before, after), [{ endpoint: ENDPOINT, field: 'coupon', media: 'application/json' }]);
});

test('a top-level oneOf in the current schema is not compared, so nothing is claimed removed', () => {
  const before = opWithBody({ type: 'object', properties: { a: { type: 'string' } } });
  const after = opWithBody({
    oneOf: [
      { type: 'object', properties: { a: { type: 'string' } } },
      { type: 'object', properties: { b: { type: 'string' } } },
    ],
  });
  assert.deepEqual(diffed(before, after), []);
});

test('an unresolved $ref inside the body is skipped rather than guessed at', () => {
  const before = opWithBody({
    type: 'object',
    properties: { a: { type: 'string' }, b: { $ref: '#/components/schemas/Missing' } },
  });
  const after = opWithBody({ type: 'object', properties: { a: { type: 'string' } } });
  assert.deepEqual(diffed(before, after), []);
});

test('a media type withdrawn entirely is not reported as field removals — that is media_type_removed', () => {
  const before = opWithBody({ type: 'object', properties: { a: { type: 'string' } } }, 'application/json');
  const after = opWithBody({ type: 'object', properties: {} }, 'application/x-www-form-urlencoded');
  assert.deepEqual(diffed(before, after), []);
});

test('an operation absent from the baseline contributes no removals', () => {
  const beforeDoc = {
    openapi: '3.0.0',
    info: { title: 't', version: 'v' },
    paths: { '/v1/other': { post: opWithBody({ type: 'object', properties: {} }) } },
  };
  const afterDoc = doc(opWithBody({ type: 'object', properties: { a: { type: 'string' } } }));
  assert.deepEqual(removedRequestFields(indexSpec(beforeDoc), indexSpec(afterDoc)), []);
});
