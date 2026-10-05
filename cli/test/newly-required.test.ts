import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newlyRequiredFields } from '../src/diff.js';
import { indexSpec } from '../src/spec.js';

/**
 * `newlyRequiredFields` is the snapshot's "newly required" number
 * (`scripts/snapshot.ts` → the site's `/changes` pages). Its whole job is to
 * never list a change that breaks nobody, because a false "breaking" on the
 * marketing site is a false claim about a vendor. These tests pin the two
 * exclusions that make that true: a required field under a parent the
 * baseline never had is not listed (the parent is, if the parent is itself
 * required), and `ids` with `ids[]` newly required is one line, not two.
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

function opWithBody(schema: unknown): Record<string, unknown> {
  return {
    requestBody: { required: true, content: { 'application/json': { schema } } },
    responses: {},
  };
}

const obj = (properties: Record<string, unknown>, required?: string[]): Record<string, unknown> => ({
  type: 'object',
  properties,
  ...(required ? { required } : {}),
});

function diffed(before: unknown, after: unknown) {
  return newlyRequiredFields(indexSpec(doc(opWithBody(before))), indexSpec(doc(opWithBody(after))));
}

const fieldsOf = (out: ReturnType<typeof newlyRequiredFields>): string[] => out.filter((f) => f.endpoint === ENDPOINT).map((f) => f.field);

test('a field that flips from optional to required is listed', () => {
  const out = diffed(obj({ a: { type: 'string' } }), obj({ a: { type: 'string' } }, ['a']));
  assert.deepEqual(fieldsOf(out), ['a']);
  assert.deepEqual(out, [{ endpoint: ENDPOINT, field: 'a' }]);
});

test('a new required field on an object that already existed is listed', () => {
  const before = obj({ settings: obj({ a: { type: 'string' } }) }, ['settings']);
  const after = obj({ settings: obj({ a: { type: 'string' }, mode: { type: 'string' } }, ['mode']) }, ['settings']);
  assert.deepEqual(fieldsOf(diffed(before, after)), ['settings.mode']);
});

test('a required child of a NEW OPTIONAL parent is not listed — nobody was sending that parent', () => {
  const before = obj({ a: { type: 'string' } });
  const after = obj({ a: { type: 'string' }, settings: obj({ mode: { type: 'string' } }, ['mode']) });
  assert.deepEqual(diffed(before, after), []);
});

test('a required child of a new REQUIRED parent is not listed — the parent is, once', () => {
  const before = obj({ a: { type: 'string' } });
  const after = obj({ a: { type: 'string' }, settings: obj({ mode: { type: 'string' } }, ['mode']) }, ['settings']);
  assert.deepEqual(fieldsOf(diffed(before, after)), ['settings']);
});

test('`ids` and `ids[]` both newly required are one listed entry, `ids`', () => {
  const before = obj({ ids: { type: 'array' } });
  const after = obj(
    { ids: { type: 'array', items: obj({ id: { type: 'string' } }) } },
    ['ids']
  );
  // Both exist in the flattened fields: the array itself, and its element slot.
  const out = diffed(before, after);
  assert.deepEqual(fieldsOf(out), ['ids']);
});

test('a required field two levels under a new parent is not listed, and the new grandparent is, once', () => {
  const before = obj({ a: { type: 'string' } });
  const after = obj(
    {
      a: { type: 'string' },
      parent: obj({ child: obj({ leaf: { type: 'string' } }, ['leaf']) }, ['child']),
    },
    ['parent']
  );
  const out = diffed(before, after);
  assert.deepEqual(fieldsOf(out), ['parent']);
});

test('a required field that was already required is not listed again', () => {
  const schema = obj({ a: { type: 'string' } }, ['a']);
  assert.deepEqual(diffed(schema, schema), []);
});

test('an operation absent from the current spec contributes nothing, and ordering is endpoint then field', () => {
  const beforeDoc = {
    openapi: '3.0.0',
    info: { title: 't', version: 'v' },
    paths: {
      '/v1/a': { post: opWithBody(obj({ a: { type: 'string' } })) },
      '/v1/b': { post: opWithBody(obj({ b: { type: 'string' } })) },
    },
  };
  const afterDoc = {
    openapi: '3.0.0',
    info: { title: 't', version: 'v' },
    paths: {
      '/v1/b': { post: opWithBody(obj({ b: { type: 'string' } }, ['b'])) },
    },
  };
  const out = newlyRequiredFields(indexSpec(beforeDoc), indexSpec(afterDoc));
  assert.deepEqual(out, [{ endpoint: 'POST /v1/b', field: 'b' }]);
});

test('an existing optional parent and its existing child both turning required are two obligations', () => {
  // Codex tier-A repro, 2026-09-27: folding every descendant into a listed
  // ancestor hid `settings.mode`, yet a caller who sent `{"settings":{}}`
  // must now add it. Only the `x[]` element-slot alias is folded.
  const before = obj({ settings: obj({ mode: { type: 'string' } }) });
  const after = obj({ settings: obj({ mode: { type: 'string' } }, ['mode']) }, ['settings']);
  assert.deepEqual(fieldsOf(diffed(before, after)), ['settings', 'settings.mode']);
});
