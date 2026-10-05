import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffEndpoints, removedRequestFields } from '../src/diff.js';
import { indexSpec } from '../src/spec.js';
import type { EndpointRef } from '../src/types.js';

/**
 * `removedRequestFields` (`radar/src/diff.ts`) exists because
 * `scripts/snapshot.ts` needs the removals themselves, but it must never drift
 * from the finding it mirrors: the page and the report have to tell the same
 * story about the same pair of specs. These tests hold the two to each other.
 *
 * For each fixture pair the set of field paths `removedRequestFields` returns
 * is compared against the set of fields named by `diffEndpoints`'
 * `request_field_removed` findings (the field path lives on the finding's
 * `at`, as `requestBody.<field>` — one media type, so `mediaAt` keeps the
 * container bare). The fixtures are the shapes where a silent drift is most
 * plausible: nesting, unions, opaque objects, unresolvable refs.
 */

const EP: EndpointRef = { method: 'POST', path: '/v1/things' };
const ENDPOINT = 'POST /v1/things';
const AT_PREFIX = 'requestBody.';

function op(schema: unknown): Record<string, unknown> {
  return {
    requestBody: { required: true, content: { 'application/json': { schema } } },
    responses: {},
  };
}

function doc(opJson: unknown): unknown {
  return {
    openapi: '3.0.0',
    info: { title: 't', version: 'v' },
    paths: { [EP.path]: { post: opJson } },
  };
}

const obj = (properties: Record<string, unknown>): Record<string, unknown> => ({ type: 'object', properties });

const anyOf = (variants: unknown[]): Record<string, unknown> => ({ anyOf: variants });

interface Pair {
  name: string;
  before: unknown;
  after: unknown;
  /** What both sides must report. A truthiness check on top of the parity assert. */
  expected: string[];
}

const pairs: Pair[] = [
  {
    name: 'a plain top-level field removed',
    before: obj({ a: { type: 'string' }, b: { type: 'string' } }),
    after: obj({ a: { type: 'string' } }),
    expected: ['b'],
  },
  {
    name: 'a nested field under a parent that was itself removed — only the parent, once',
    before: obj({ parent: { type: 'object', properties: { x: { type: 'string' }, y: { type: 'string' } } } }),
    after: obj({}),
    expected: ['parent'],
  },
  {
    name: 'a field under an anyOf union whose parent survives — the union was never enumerated, so nothing',
    before: obj({ keep: { type: 'string' }, u: anyOf([obj({ x: { type: 'string' }, y: { type: 'string' } })]) }),
    after: obj({ keep: { type: 'string' }, u: anyOf([obj({ x: { type: 'string' } })]) }),
    expected: [],
  },
  {
    name: 'a removed plain field whose union sibling was also removed — both are named',
    before: obj({ drop: { type: 'string' }, u: anyOf([{ type: 'string' }, obj({ id: { type: 'string' } })]) }),
    after: obj({}),
    expected: ['drop', 'u'],
  },
  {
    name: 'an object that became free-form — nothing enumerated, nothing claimed removed',
    before: obj({ a: { type: 'string' } }),
    after: { type: 'object', additionalProperties: true },
    expected: [],
  },
  {
    name: 'an unresolvable $ref on the current side — skipped, not guessed at',
    before: obj({ a: { type: 'string' }, b: { type: 'string' } }),
    after: obj({ a: { type: 'string' }, b: { $ref: '#/components/schemas/Missing' } }),
    expected: [],
  },
];

for (const pair of pairs) {
  test(`parity: ${pair.name}`, () => {
    const baseline = indexSpec(doc(op(pair.before)));
    const current = indexSpec(doc(op(pair.after)));

    const result = diffEndpoints({ vendor: 'v', baseline, current, endpoints: [EP] });
    const fromFindings = result.findings
      .filter((f) => f.kind === 'request_field_removed')
      .map((f) => {
        assert.ok(f.at, 'a request_field_removed finding carries its path in `at`');
        assert.ok(f.at.startsWith(AT_PREFIX), `\`at\` is ${f.at}, expected ${AT_PREFIX}<field>`);
        return f.at.slice(AT_PREFIX.length);
      });

    const fromStandalone = removedRequestFields(baseline, current)
      .filter((r) => r.endpoint === ENDPOINT)
      .map((r) => r.field);

    const findingsSet = [...new Set(fromFindings)].sort();
    const standaloneSet = [...new Set(fromStandalone)].sort();
    assert.deepEqual(standaloneSet, findingsSet, 'removedRequestFields disagrees with the findings');
    assert.deepEqual(findingsSet, [...pair.expected].sort(), 'both disagree with the expected set');
    // "only the parent, once" must hold on the findings side too, not just in the sets.
    assert.equal(fromFindings.length, pair.expected.length, 'no field is reported twice by diffEndpoints');
    assert.equal(fromStandalone.length, pair.expected.length, 'no field is reported twice by removedRequestFields');
  });
}
