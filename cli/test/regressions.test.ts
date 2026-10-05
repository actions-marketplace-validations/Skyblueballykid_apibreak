/**
 * One test per defect found in the 2026-09-16 independent review of the engine.
 *
 * Every case in here is a real false negative that shipped in the first draft:
 * a change that would have broken a caller while the check reported a clean
 * run. They are grouped by the review's numbering so a future reader can find
 * the finding each one protects, and each name says what breaks if it fails.
 *
 * The review's verdict was "do not ship", and these are the reason it is now
 * shippable. Deleting one of these tests re-opens the bug it names.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffEndpoints, removedRequestFields } from '../src/diff.js';
import { deref, indexSpec, parameters, stableKey } from '../src/spec.js';
import { exitCode, renderMarkdown } from '../src/report.js';
import type { EndpointRef, Finding, RunReport } from '../src/types.js';

const EP: EndpointRef = { method: 'POST', path: '/v1/things' };

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

/** An operation with an optional JSON request body and an optional 200 JSON response. */
function op(parts: { body?: Json; response?: Json; bodyRequired?: boolean; params?: Json[] }): Json {
  const out: Json = { responses: {} };
  if (parts.body !== undefined) {
    out.requestBody = { content: { 'application/json': { schema: parts.body } } };
    if (parts.bodyRequired !== undefined) out.requestBody.required = parts.bodyRequired;
  }
  out.responses['200'] =
    parts.response === undefined ? { description: 'ok' } : { content: { 'application/json': { schema: parts.response } } };
  if (parts.params) out.params = undefined;
  if (parts.params) out.parameters = parts.params;
  return out;
}

function doc(operation: Json, pathLevel?: Json): Json {
  const item: Json = { post: operation };
  if (pathLevel) item.parameters = pathLevel;
  return { openapi: '3.0.0', info: { title: 't', version: 'v' }, paths: { [EP.path]: item } };
}

function run(baseline: Json, current: Json, endpoints: EndpointRef[] = [EP]) {
  return diffEndpoints({ vendor: 'v', baseline: indexSpec(baseline), current: indexSpec(current), endpoints });
}

function kinds(result: { findings: Finding[] }): string[] {
  return result.findings.map((f) => f.kind);
}

function find(result: { findings: Finding[] }, kind: string): Finding {
  const found = result.findings.find((f) => f.kind === kind);
  assert.ok(found, `expected a ${kind} finding, got ${JSON.stringify(kinds(result))}`);
  return found;
}

const obj = (properties: Json, required?: string[]): Json => ({
  type: 'object',
  properties,
  ...(required ? { required } : {}),
});

/* ── Review finding 1: nested structure was invisible ─────────────────────── */

test('a response field removed two levels down is breaking (it used to read as a clean run)', () => {
  const before = op({ response: obj({ data: obj({ id: { type: 'string' }, name: { type: 'string' } }) }) });
  const after = op({ response: obj({ data: obj({ name: { type: 'string' } }) }) });
  const result = run(doc(before), doc(after));
  const finding = find(result, 'response_field_removed');
  assert.equal(finding.at, 'response.200.data.id');
  assert.equal(finding.severity, 'breaking');
});

test("a field removed from an array's items is breaking, and its path names the array", () => {
  const before = op({ response: obj({ items: { type: 'array', items: obj({ id: { type: 'string' }, tag: { type: 'string' } }) } }) });
  const after = op({ response: obj({ items: { type: 'array', items: obj({ id: { type: 'string' } }) } }) });
  const result = run(doc(before), doc(after));
  assert.equal(find(result, 'response_field_removed').at, 'response.200.items[].tag');
});

test('a field that changes type is breaking', () => {
  const before = op({ body: obj({ amount: { type: 'string' } }) });
  const after = op({ body: obj({ amount: { type: 'integer' } }) });
  const finding = find(run(doc(before), doc(after)), 'field_type_changed');
  assert.match(finding.detail, /from string to integer/);
});

test('a request body that becomes required is breaking', () => {
  const before = op({ body: obj({ a: { type: 'string' } }), bodyRequired: false });
  const after = op({ body: obj({ a: { type: 'string' } }), bodyRequired: true });
  assert.equal(find(run(doc(before), doc(after)), 'request_body_now_required').severity, 'breaking');
});

test('a request body the baseline declared and the current spec does not is breaking', () => {
  const result = run(doc(op({ body: obj({ a: { type: 'string' } }) })), doc(op({})));
  assert.equal(find(result, 'request_body_removed').severity, 'breaking');
});

/* ── Review finding 2: unresolved references disappeared ──────────────────── */

test('a request body $ref pointing outside the document is not_compared, not an empty body', () => {
  const before = op({ body: obj({ a: { type: 'string' } }) });
  const after = { responses: { '200': { description: 'ok' } }, requestBody: { $ref: 'https://elsewhere/x.json#/b' } };
  const result = run(doc(before), doc(after));
  assert.equal(kinds(result).includes('not_compared'), true);
  assert.equal(kinds(result).includes('request_field_removed'), false);
});

test('an unresolvable $ref inside a response is not_compared, not a skipped response', () => {
  const before = op({ response: obj({ a: { type: 'string' } }) });
  const after = { responses: { '200': { $ref: '#/components/responses/Missing' } } };
  const result = run(doc(before), doc(after));
  assert.equal(find(result, 'not_compared').severity, 'not_compared');
  assert.equal(kinds(result).includes('response_field_removed'), false);
});

test('an unresolvable property $ref is not_compared at that property, and its siblings still compare', () => {
  const before = op({ body: obj({ a: { type: 'string' }, b: { type: 'string' } }) });
  const after = op({ body: obj({ a: { $ref: '#/components/schemas/Gone' }, b: { type: 'integer' } }) });
  const result = run(doc(before), doc(after));
  assert.equal(find(result, 'not_compared').at, 'requestBody.a');
  assert.equal(find(result, 'field_type_changed').at, 'requestBody.b');
});

test('a parameter $ref that does not resolve is not_compared, not a dropped parameter', () => {
  const before = op({ body: obj({}) , params: [{ name: 'q', in: 'query' }] });
  const after = op({ body: obj({}), params: [{ $ref: '#/components/parameters/Gone' }] });
  const result = run(doc(before), doc(after));
  assert.match(find(result, 'not_compared').detail, /parameter was not compared/);
});

// Round-4 follow-up review, 2026-09-30 (bullet 5): when a BASELINE parameter
// entry cannot even be read as a parameter object (an unresolved $ref), the
// baseline's true parameter set for this operation is not fully known — a
// parameter that looks "new and required" might in fact be the very entry
// that could not be read. `parameter_now_required` must be withheld for the
// WHOLE operation, not just the unreadable entry itself (which still gets its
// own `not_compared`, as the test above already covers).
test('a baseline parameter that cannot be read at all withholds parameter_now_required for the whole operation', () => {
  const before = op({ body: obj({}), params: [{ $ref: '#/components/parameters/Gone' }] });
  const after = op({ body: obj({}), params: [{ name: 'q', in: 'query', required: true }] });
  const result = run(doc(before), doc(after));
  assert.match(find(result, 'not_compared').detail, /parameter was not compared/);
  assert.equal(kinds(result).includes('parameter_now_required'), false);
});

// The same operation with EVERY baseline parameter readable must still
// report the ordinary breaking finding — the guard above must not become a
// blanket suppression once any operation happens to have a $ref anywhere.
test('parameter_now_required still fires normally when every baseline parameter is readable', () => {
  const before = op({ body: obj({}), params: [] });
  const after = op({ body: obj({}), params: [{ name: 'q', in: 'query', required: true }] });
  const result = run(doc(before), doc(after));
  assert.equal(kinds(result).includes('parameter_now_required'), true);
});

test('a schema nested deeper than the reader follows is not_compared, never assumed unchanged', () => {
  let deep: Json = obj({ leaf: { type: 'string' } });
  for (let i = 0; i < 12; i += 1) deep = obj({ [`level${i}`]: deep });
  const result = run(doc(op({ body: deep })), doc(op({ body: obj({ level11: obj({}) }) })));
  assert.equal(kinds(result).includes('not_compared'), true);
});

/* ── Review finding 3: required parameters were missed ────────────────────── */

test('a parameter that arrives already required is breaking (the baseline had no such parameter)', () => {
  const before = op({ params: [] });
  const after = op({ params: [{ name: 'token', in: 'query', required: true }] });
  const finding = find(run(doc(before), doc(after)), 'parameter_now_required');
  assert.equal(finding.at, 'parameters.query.token');
  assert.match(finding.detail, /new and required/);
});

test('a path-level parameter is inherited, so flipping it to required is breaking', () => {
  const before = doc(op({}), [{ name: 'org', in: 'query', required: false }]);
  const after = doc(op({}), [{ name: 'org', in: 'query', required: true }]);
  assert.equal(find(run(before, after), 'parameter_now_required').severity, 'breaking');
});

test('an operation-level parameter overrides the path-level one of the same name', () => {
  const before = doc(op({ params: [{ name: 'org', in: 'query', required: false }] }), [
    { name: 'org', in: 'query', required: true },
  ]);
  const after = doc(op({ params: [{ name: 'org', in: 'query', required: false }] }), [
    { name: 'org', in: 'query', required: true },
  ]);
  assert.deepEqual(kinds(run(before, after)), []);
});

test('a parameter enum that loses a value is breaking and names the replacement set', () => {
  const before = op({ params: [{ name: 'mode', in: 'query', schema: { enum: ['a', 'b'] } }] });
  const after = op({ params: [{ name: 'mode', in: 'query', schema: { enum: ['b'] } }] });
  const finding = find(run(doc(before), doc(after)), 'enum_value_removed');
  assert.match(finding.detail, /no longer accepts "a"/);
  assert.match(finding.detail, /now accepts "b"/);
});

/* ── Review finding 4: alternatives were silently skipped ─────────────────── */

test('a multipart request field removed while the JSON body is unchanged is still breaking', () => {
  const media = (mp: Json): Json => ({
    responses: { '200': { description: 'ok' } },
    requestBody: {
      content: {
        'application/json': { schema: obj({ a: { type: 'string' } }) },
        'multipart/form-data': { schema: mp },
      },
    },
  });
  const result = run(
    doc(media(obj({ file: { type: 'string' }, note: { type: 'string' } }))),
    doc(media(obj({ file: { type: 'string' } })))
  );
  assert.equal(find(result, 'request_field_removed').at, 'requestBody(multipart/form-data).note');
});

test('a request media type the baseline offered and the current spec does not is breaking', () => {
  const both: Json = {
    responses: { '200': { description: 'ok' } },
    requestBody: {
      content: {
        'application/json': { schema: obj({ a: { type: 'string' } }) },
        'application/x-www-form-urlencoded': { schema: obj({ a: { type: 'string' } }) },
      },
    },
  };
  const jsonOnly = op({ body: obj({ a: { type: 'string' } }) });
  const finding = find(run(doc(both), doc(jsonOnly)), 'media_type_removed');
  assert.match(finding.detail, /x-www-form-urlencoded/);
});

test('a 201 response emptied while the 200 response is unchanged is still breaking', () => {
  const twoStatuses = (created: Json): Json => ({
    responses: {
      '200': { content: { 'application/json': { schema: obj({ a: { type: 'string' } }) } } },
      '201': { content: { 'application/json': { schema: created } } },
    },
  });
  const result = run(
    doc(twoStatuses(obj({ id: { type: 'string' } }))),
    doc(twoStatuses(obj({})))
  );
  assert.equal(find(result, 'response_field_removed').at, 'response.201.id');
});

test('a 2xx status the baseline declared and the current spec drops is breaking', () => {
  const before: Json = {
    responses: {
      '200': { content: { 'application/json': { schema: obj({ a: { type: 'string' } }) } } },
      '202': { content: { 'application/json': { schema: obj({ a: { type: 'string' } }) } } },
    },
  };
  const after = op({ response: obj({ a: { type: 'string' } }) });
  assert.match(find(run(doc(before), doc(after)), 'response_status_removed').detail, /202/);
});

// Round-4 follow-up review, 2026-09-30 (bullet 6): an ADDED status code (only
// in the current spec) used to be counted purely `additive`, with no check
// for whether it could even be read — an unresolved $ref on a brand-new
// status silently read as "fine, it's new" rather than being surfaced.
test('an added status code that cannot be read is not_compared, not silently assumed fine', () => {
  const before = op({ response: obj({ a: { type: 'string' } }) });
  const after: Json = {
    responses: {
      '200': { content: { 'application/json': { schema: obj({ a: { type: 'string' } }) } } },
      '201': { $ref: '#/components/responses/Missing' },
    },
  };
  const result = run(doc(before), doc(after));
  assert.match(find(result, 'not_compared').detail, /201/);
  assert.equal(result.additiveChanges > 0, true);
});

// The same rule for an ADDED media type inside a status both specs declare.
test('an added media type on an existing status that cannot be read is not_compared, not silently assumed fine', () => {
  const before = op({ response: obj({ a: { type: 'string' } }) });
  const after: Json = {
    responses: {
      '200': {
        content: {
          'application/json': { schema: obj({ a: { type: 'string' } }) },
          'application/xml': { schema: { $ref: '#/components/schemas/Missing' } },
        },
      },
    },
  };
  const result = run(doc(before), doc(after));
  assert.match(find(result, 'not_compared').detail, /application\/xml/);
  assert.equal(result.additiveChanges > 0, true);
});

// An added status/media that IS readable stays purely additive — the guard
// above must not turn every addition into a not_compared finding.
test('an added, readable status code stays purely additive with no not_compared finding for it', () => {
  const before = op({ response: obj({ a: { type: 'string' } }) });
  const after: Json = {
    responses: {
      '200': { content: { 'application/json': { schema: obj({ a: { type: 'string' } }) } } },
      '201': { content: { 'application/json': { schema: obj({ id: { type: 'string' } }) } } },
    },
  };
  const result = run(doc(before), doc(after));
  assert.equal(kinds(result).includes('not_compared'), false);
  assert.equal(result.additiveChanges > 0, true);
});

// Round-5 review, P2 (bullet 4): round 4's #6 fix only checked
// `shapeB.unknowns.get('')` — a ROOT-level refusal — for an added status
// code or an added media type. A refusal NESTED inside the added shape (a
// `oneOf` union under a nested `properties` path, say) was never checked at
// all, and the whole added entry silently read as purely additive. Every
// refused path within `shapeB.unknowns`, not just a root-level one, must
// surface its own (or a grouped) not_compared finding.
test('an added media type with a NESTED (non-root) refusal is not_compared, not silently swallowed as purely additive', () => {
  const before = op({ response: obj({ a: { type: 'string' } }) });
  const after: Json = {
    responses: {
      '200': {
        content: {
          'application/json': { schema: obj({ a: { type: 'string' } }) },
          'application/xml': {
            schema: obj({ a: { type: 'string' }, b: { oneOf: [{ type: 'string' }, { type: 'number' }] } }),
          },
        },
      },
    },
  };
  const result = run(doc(before), doc(after));
  const finding = find(result, 'not_compared');
  assert.match(finding.detail, /application\/xml/);
  assert.match(finding.at ?? '', /^response\.200/);
});

// Same rule for an ADDED status code whose media has a nested refusal.
test('an added status code with a NESTED (non-root) refusal in its media is not_compared, not silently swallowed', () => {
  const before = op({ response: obj({ a: { type: 'string' } }) });
  const after: Json = {
    responses: {
      '200': { content: { 'application/json': { schema: obj({ a: { type: 'string' } }) } } },
      '201': {
        content: {
          'application/json': {
            schema: obj({ a: { type: 'string' }, b: { oneOf: [{ type: 'string' }, { type: 'number' }] } }),
          },
        },
      },
    },
  };
  const result = run(doc(before), doc(after));
  const finding = find(result, 'not_compared');
  assert.match(finding.detail, /201/);
  assert.equal(result.additiveChanges > 0, true);
});

// Round-6 review, P1: an operation-level parameter entry that fails to
// resolve at all (an external/unresolved $ref) has an unknown name and
// `in` — it could be overriding ANY inherited path-level parameter, not
// just one with a matching name. Round 5's #3 fix only suppressed a
// SAME-NAME shadow; this must suppress every inherited path-level
// parameter's comparison for the whole operation on that side, and report
// it as ONE not_compared finding, not a per-parameter breakdown, and never
// as an ordinary enum/type finding on the inherited parameter.
test('an unresolved operation-level parameter override suppresses every inherited path-level parameter, not just a same-named one', () => {
  const pathLevel = [{ name: 'q', in: 'query', schema: { enum: ['a', 'b'] } }];
  const opWithUnresolvedOverride: Json = { ...op({ params: [{ $ref: './params.yaml#/Q' }] }) };
  const before = doc(opWithUnresolvedOverride, pathLevel);
  const afterPathLevel = [{ name: 'q', in: 'query', schema: { enum: ['a'] } }];
  const after = doc(opWithUnresolvedOverride, afterPathLevel);
  const result = run(before, after);
  assert.equal(kinds(result).includes('enum_value_removed'), false);
  assert.equal(kinds(result).includes('parameter_now_required'), false);
  const notCompared = result.findings.filter((f) => f.kind === 'not_compared');
  assert.ok(
    notCompared.some((f) => /inherited path-level parameter/.test(f.detail)),
    `expected a not_compared finding about inherited path-level parameters, got ${JSON.stringify(notCompared.map((f) => f.detail))}`
  );
});

// The suppression must not leak to a parameter that only ever existed at
// the operation level (never inherited) — this is scoped to path-level
// inheritance specifically.
test('an unresolved operation-level parameter override does not suppress a comparison for a non-inherited, operation-only parameter', () => {
  const before = doc(
    op({ params: [{ $ref: './params.yaml#/Q' }, { name: 'limit', in: 'query', schema: { enum: ['a', 'b'] } }] })
  );
  const after = doc(
    op({ params: [{ $ref: './params.yaml#/Q' }, { name: 'limit', in: 'query', schema: { enum: ['a'] } }] })
  );
  const result = run(before, after);
  assert.equal(kinds(result).includes('enum_value_removed'), true);
});

/* ── Review finding 5: allOf overwrote instead of intersecting ─────────────── */

test('two allOf branches defining one field differently are not_compared, not a silent overwrite', () => {
  const schema = (first: Json): Json => ({
    allOf: [obj({ x: first }), obj({ x: { type: 'string' } })],
  });
  const result = run(doc(op({ body: schema({ enum: ['a', 'b'] }) })), doc(op({ body: schema({ enum: ['a'] }) })));
  assert.equal(find(result, 'not_compared').at, 'requestBody.x');
});

test('an allOf enum is intersected, so narrowing one branch is breaking', () => {
  const schema = (values: string[]): Json => ({
    allOf: [{ type: 'object', properties: { x: { enum: values } } }, { type: 'object', required: ['x'] }],
  });
  const result = run(doc(op({ body: schema(['a', 'b']) })), doc(op({ body: schema(['a']) })));
  assert.match(find(result, 'enum_value_removed').detail, /no longer accepts "b"/);
});

/* ── Review finding 6: enum narrowing had two false negatives ─────────────── */

test('a request field that was unrestricted and now has an enum is breaking', () => {
  const before = op({ body: obj({ mode: { type: 'string' } }) });
  const after = op({ body: obj({ mode: { type: 'string', enum: ['a'] } }) });
  const finding = find(run(doc(before), doc(after)), 'enum_now_restricted');
  assert.match(finding.detail, /now accepts only "a"/);
});

test('an enum value that changes JSON type is a removal, because 1 and "1" are different values', () => {
  const before = op({ body: obj({ n: { enum: [1] } }) });
  const after = op({ body: obj({ n: { enum: ['1'] } }) });
  const finding = find(run(doc(before), doc(after)), 'enum_value_removed');
  assert.match(finding.detail, /no longer accepts 1\b/);
});

test('a response enum that gains a value is advisory, because a caller\'s parser has no branch for it', () => {
  const before = op({ response: obj({ status: { enum: ['ok'] } }) });
  const after = op({ response: obj({ status: { enum: ['ok', 'pending'] } }) });
  const finding = find(run(doc(before), doc(after)), 'enum_value_added');
  assert.equal(finding.severity, 'advisory');
  assert.match(finding.detail, /may now return "pending"/);
});

test('an enum member that cannot be stringified does not crash the run', () => {
  const hostile = JSON.parse('{"toString": null}');
  const before = op({ body: obj({ n: { enum: [hostile] } }) });
  const after = op({ body: obj({ n: { enum: [] } }) });
  const result = run(doc(before), doc(after));
  assert.equal(kinds(result).includes('enum_value_removed'), true);
});

/* ── Review finding 7: inherited properties hid removals ──────────────────── */

test('a removed field named toString is detected like any other', () => {
  const before = op({ body: obj({ toString: { type: 'string' }, keep: { type: 'string' } }) });
  const after = op({ body: obj({ keep: { type: 'string' } }) });
  assert.equal(find(run(doc(before), doc(after)), 'request_field_removed').at, 'requestBody.toString');
});

test('a published __proto__ property is compared as data and reaches no prototype', () => {
  const before = op({ body: JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}') });
  const after = op({ body: obj({}) });
  const result = run(doc(before), doc(after));
  assert.equal(find(result, 'request_field_removed').at, 'requestBody.__proto__');
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('a $ref at #/__proto__ does not resolve to Object.prototype', () => {
  const before = op({ body: obj({ a: { type: 'string' } }) });
  const after = op({ body: { $ref: '#/__proto__' } });
  assert.equal(kinds(run(doc(before), doc(after))).includes('not_compared'), true);
});

/* ── Review finding 8: unknown-only runs passed CI ────────────────────────── */

function reportWith(findings: Finding[]): RunReport {
  return {
    generatedAt: '2026-09-16T00:00:00Z',
    sources: [],
    endpointsChecked: 1,
    endpointsSkipped: 0,
    additiveChanges: 0,
    findings,
  };
}

const unknownOnly = reportWith([
  { kind: 'unknown', severity: 'unknown', vendor: 'v', endpoint: 'POST /x', detail: 'HTTP 503' },
]);

test('a report containing only unknown findings fails the build at the default threshold', () => {
  assert.equal(exitCode(unknownOnly, 'breaking'), 2);
});

test('only --fail-on never lets an unknown-only report pass', () => {
  assert.equal(exitCode(unknownOnly, 'never'), 0);
  assert.equal(exitCode(unknownOnly, 'deprecation'), 2);
  assert.equal(exitCode(unknownOnly, 'unknown'), 2);
});

test('a not_compared-only report passes at every threshold, because it is a standing limit and not a failed run', () => {
  const structural = reportWith([
    {
      kind: 'not_compared',
      severity: 'not_compared',
      vendor: 'v',
      endpoint: 'POST /x',
      detail: 'an anyOf/oneOf union, which this check does not compare',
    },
  ]);
  for (const level of ['breaking', 'deprecation', 'unknown', 'never'] as const) {
    assert.equal(exitCode(structural, level), 0);
  }
});

test('an advisory-only report still passes, at every threshold', () => {
  const advisory = reportWith([
    { kind: 'enum_value_added', severity: 'advisory', vendor: 'v', endpoint: 'POST /x', detail: 'new value' },
  ]);
  for (const level of ['breaking', 'deprecation', 'unknown', 'never'] as const) {
    assert.equal(exitCode(advisory, level), 0);
  }
});

/* ── Review finding 10: malformed specs crashed or lied ───────────────────── */

test('a specification with no paths object is unknown for every declared endpoint, never a list of removals', () => {
  const result = run(doc(op({ body: obj({ a: { type: 'string' } }) })), { openapi: '3.0.0', info: {} });
  assert.deepEqual(kinds(result), ['unknown']);
  assert.equal(result.endpointsChecked, 0);
  assert.equal(result.endpointsSkipped, 1);
  assert.match(result.findings[0]?.detail ?? '', /could not be read/);
});

test('a specification that is not an object at all is unknown, not empty', () => {
  const result = run(doc(op({})), 'a gateway error page');
  assert.deepEqual(kinds(result), ['unknown']);
});

test('an operation published as an array is not treated as an operation', () => {
  const before = doc(op({ body: obj({ a: { type: 'string' } }) }));
  const after = { openapi: '3.0.0', info: {}, paths: { [EP.path]: { post: [] }, '/other': { get: op({}) } } };
  const result = run(before, after);
  assert.deepEqual(kinds(result), ['operation_removed']);
});

/* ── Review finding 11: report prose and formatting ───────────────────────── */

test('a newline in a vendor-written detail cannot forge a table row', () => {
  const markdown = renderMarkdown(
    reportWith([
      {
        kind: 'request_field_removed',
        severity: 'breaking',
        vendor: 'v',
        endpoint: 'POST /x',
        detail: 'a\n| breaking | v | `POST /y` | invented',
      },
    ])
  );
  const rows = markdown.split('\n').filter((l) => l.startsWith('| '));
  // Header, separator, one finding. A fourth row would be the vendor's.
  assert.equal(rows.length, 3);
});

test('a pipe in a vendor-written detail stays inside its cell', () => {
  const markdown = renderMarkdown(
    reportWith([
      { kind: 'unknown', severity: 'unknown', vendor: 'v', endpoint: 'POST /x', detail: 'a | b' },
    ])
  );
  assert.match(markdown, /a \\\| b/);
});

/* ── The opaque-object rule, which the fixes above depend on ──────────────── */

test('a parent that stops enumerating its fields is one not_compared, not a removal for each field', () => {
  const before = op({ response: obj({ data: obj({ a: { type: 'string' }, b: { type: 'string' } }) }) });
  const after = op({ response: obj({ data: { type: 'object' } }) });
  const result = run(doc(before), doc(after));
  assert.deepEqual(kinds(result), ['not_compared']);
  assert.equal(find(result, 'not_compared').at, 'response.200.data');
});

test('an explicitly empty properties map is a removal, because the vendor said there are no fields', () => {
  const before = op({ body: obj({ a: { type: 'string' } }) });
  const after = op({ body: obj({}) });
  assert.equal(find(run(doc(before), doc(after)), 'request_field_removed').at, 'requestBody.a');
});

test('stableKey distinguishes JSON types and ignores property order', () => {
  assert.notEqual(stableKey(1), stableKey('1'));
  assert.equal(stableKey({ a: 1, b: 2 }), stableKey({ b: 2, a: 1 }));
  const cyclic: Json = { a: 1 };
  cyclic.self = cyclic;
  assert.equal(typeof stableKey(cyclic), 'string');
});

/* ── Readability rules, which are correctness rules in disguise ───────────── */

test('a required field inside a brand-new optional object is not breaking, because nobody was sending that object', () => {
  const before = op({ body: obj({ a: { type: 'string' } }) });
  const after = op({ body: obj({ a: { type: 'string' }, settings: obj({ mode: { type: 'string' } }, ['mode']) }) });
  const result = run(doc(before), doc(after));
  assert.deepEqual(kinds(result), []);
  assert.equal(result.additiveChanges > 0, true);
});

test('a required field inside an object that was already required is breaking', () => {
  const before = op({ body: obj({ settings: obj({ a: { type: 'string' } }) }, ['settings']) });
  const after = op({ body: obj({ settings: obj({ a: { type: 'string' }, mode: { type: 'string' } }, ['mode']) }, ['settings']) });
  assert.equal(find(run(doc(before), doc(after)), 'request_field_now_required').at, 'requestBody.settings.mode');
});

test('a required field inside a required array element is breaking', () => {
  const items = (required?: string[]): Json => ({
    type: 'array',
    items: obj({ price: { type: 'string' }, quantity: { type: 'integer' } }, required),
  });
  const before = op({ body: obj({ line_items: items() }, ['line_items']) });
  const after = op({ body: obj({ line_items: items(['quantity']) }, ['line_items']) });
  assert.equal(
    find(run(doc(before), doc(after)), 'request_field_now_required').at,
    'requestBody.line_items[].quantity'
  );
});

test('a removed object is one finding naming the parent and counting its nested fields', () => {
  const coupon = obj({ id: { type: 'string' }, name: { type: 'string' }, percent_off: { type: 'number' } });
  const before = op({ response: obj({ code: { type: 'string' }, coupon }) });
  const after = op({ response: obj({ code: { type: 'string' } }) });
  const result = run(doc(before), doc(after));
  assert.equal(result.findings.length, 1);
  const finding = find(result, 'response_field_removed');
  assert.equal(finding.at, 'response.200.coupon');
  assert.match(finding.detail, /and its 3 nested fields/);
});

test('many fields refused for the same reason are one grouped not_compared, not one each', () => {
  const union = { oneOf: [{ type: 'string' }, { type: 'integer' }] };
  const schema = obj({ a: union, b: union, c: union, d: union });
  const result = run(doc(op({ body: schema })), doc(op({ body: schema })));
  assert.equal(result.findings.length, 1);
  const finding = find(result, 'not_compared');
  assert.match(finding.detail, /^4 fields were not compared/);
  assert.match(finding.detail, /anyOf\/oneOf/);
});

test('a single media type is not named in the path, and competing media types are', () => {
  const formOnly = (schema: Json): Json => ({
    responses: { '200': { description: 'ok' } },
    requestBody: { content: { 'application/x-www-form-urlencoded': { schema } } },
  });
  const one = run(doc(formOnly(obj({ a: { type: 'string' } }))), doc(formOnly(obj({}))));
  assert.equal(find(one, 'request_field_removed').at, 'requestBody.a');
});

/* ── $ref with structural siblings is refused, not followed-with-siblings-dropped ──
 *
 * Found in the 2026-09-27 follow-up review: `deref` used to keep only the
 * referenced target and silently drop every other key on the node, so a
 * schema published as `{$ref: X, properties: {...}}` (draft-07 style, which
 * OpenAPI 3.0 forbids) was compared as if the inline `properties` did not
 * exist. `b` below survives only because the dropped inline properties
 * happened to re-list it; a vendor dropping `b` from *both* places would
 * still have been caught, but one moving the field inline would not. Rather
 * than guess, refuse: the comparison says `not_compared` at the body.
 */

const REF_WITH_PROPERTIES: Json = {
  $ref: '#/components/schemas/Thing',
  properties: { b: { type: 'string' } },
};

const THING: Json = { type: 'object', properties: { a: { type: 'string' } } };

function withComponents(operation: Json, schemas: Json): Json {
  return { openapi: '3.0.0', info: { title: 't', version: 'v' }, paths: { [EP.path]: { post: operation } }, components: { schemas } };
}

test('a $ref carrying a structural sibling is not_compared, and the silently-dropped siblings claim nothing', () => {
  const before = op({ body: obj({ a: { type: 'string' }, b: { type: 'string' } }) });
  const after: Json = { responses: { '200': { description: 'ok' } }, requestBody: { content: { 'application/json': { schema: REF_WITH_PROPERTIES } } } };
  const result = run(withComponents(before, { Thing: THING }), withComponents(after, { Thing: THING }));
  // The refusal is at the body, not a clean run and not a removal.
  assert.equal(kinds(result).includes('not_compared'), true);
  assert.equal(kinds(result).includes('request_field_removed'), false);
  // The standalone rule agrees: `b` is not called removed, because the node
  // the check was asked to read could not be read at all.
  assert.deepEqual(
    removedRequestFields(indexSpec(withComponents(before, { Thing: THING })), indexSpec(withComponents(after, { Thing: THING }))),
    []
  );
});

test('a $ref with only a description sibling still resolves, and a real removal through it is reported', () => {
  const before: Json = { responses: { '200': { description: 'ok' } }, requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Thing', description: 'a thing' } } } } };
  const after = op({ body: obj({}) });
  const result = run(withComponents(before, { Thing: THING }), withComponents(after, { Thing: THING }));
  assert.equal(find(result, 'request_field_removed').at, 'requestBody.a');
});

test('a $ref beside a 2019-09 applicator (dependentSchemas) is refused too, not read as a removal', () => {
  // Codex tier-A repro, 2026-09-27: `dependentSchemas` re-lists `b`, and the
  // first cut of the refusal set did not include it, so `b` read as removed.
  const before = op({ body: obj({ a: { type: 'string' }, b: { type: 'string' } }) });
  const schema: Json = { $ref: '#/components/schemas/Thing', dependentSchemas: { a: { properties: { b: { type: 'string' } } } } };
  const after: Json = { responses: { '200': { description: 'ok' } }, requestBody: { content: { 'application/json': { schema } } } };
  const result = run(withComponents(before, { Thing: THING }), withComponents(after, { Thing: THING }));
  assert.equal(kinds(result).includes('request_field_removed'), false);
  assert.equal(kinds(result).includes('not_compared'), true);
});

/* ── OpenAPI 3.1 path-item $ref: a Path Item Object with no method keys of its own ──
 *
 * A 3.1 document may write a path item as `{"$ref": "#/components/pathItems/Foo"}`,
 * with every method living on the referenced target rather than on the node
 * under `paths`. `indexSpec` used to read methods straight off that node,
 * found none, and the endpoint read as declaring no operations — so the diff
 * reported a false `operation_removed` for every method it owns. Every
 * fixture below also declares a plain inline `/ping`, so the document is
 * never read as "declares no operations" for a reason unrelated to the path
 * item under test.
 */

const WIDGET_GET: Json = {
  responses: { '200': { content: { 'application/json': { schema: obj({ id: { type: 'string' } }) } } } },
};
const PING_GET: Json = { responses: { '200': { description: 'ok' } } };
const WIDGET_EP: EndpointRef = { method: 'GET', path: '/widgets/{id}' };

function widgetDoc(widgetItem: Json, pathItems?: Json): Json {
  return {
    openapi: '3.1.0',
    info: { title: 't', version: 'v' },
    paths: { '/widgets/{id}': widgetItem, '/ping': { get: PING_GET } },
    ...(pathItems ? { components: { pathItems } } : {}),
  };
}

test('a path item written as a standalone $ref (OpenAPI 3.1 components.pathItems) is read like an inline one', () => {
  const widgetRef = { $ref: '#/components/pathItems/Widget' };
  const baseline = widgetDoc(widgetRef, { Widget: { get: WIDGET_GET } });
  const current = widgetDoc(widgetRef, { Widget: { get: WIDGET_GET } });
  const result = run(baseline, current, [WIDGET_EP]);
  assert.deepEqual(result.findings, []);
  assert.equal(result.endpointsChecked, 1);
});

test('moving an operation from inline to a path-item $ref is not a breaking change', () => {
  const baseline = widgetDoc({ get: WIDGET_GET });
  const current = widgetDoc({ $ref: '#/components/pathItems/Widget' }, { Widget: { get: WIDGET_GET } });
  const result = run(baseline, current, [WIDGET_EP]);
  assert.deepEqual(result.findings, []);
});

test('an external path-item $ref is unknown for the declared endpoint, never operation_removed', () => {
  const baseline = widgetDoc({ get: WIDGET_GET });
  const current = widgetDoc({ $ref: 'other.yaml#/Foo' });
  assert.equal(typeof indexSpec(current).unreadable, 'string');
  const result = run(baseline, current, [WIDGET_EP]);
  assert.deepEqual(kinds(result), ['unknown']);
});

test('a path-item $ref with a sibling get is unreadable, not a silent merge', () => {
  const current = widgetDoc(
    { $ref: '#/components/pathItems/Widget', get: WIDGET_GET },
    { Widget: { get: WIDGET_GET } }
  );
  assert.equal(typeof indexSpec(current).unreadable, 'string');
});

test('a sibling get at the middle hop of a $ref chain is unreadable, not a silently dropped get', () => {
  const current = widgetDoc(
    { $ref: '#/components/pathItems/X' },
    { X: { $ref: '#/components/pathItems/Y', get: WIDGET_GET }, Y: { post: WIDGET_GET } }
  );
  assert.equal(typeof indexSpec(current).unreadable, 'string');
});

test('a sibling parameters at the middle hop of a $ref chain is unreadable too', () => {
  const current = widgetDoc(
    { $ref: '#/components/pathItems/X' },
    {
      X: { $ref: '#/components/pathItems/Y', parameters: [{ name: 'id', in: 'path', required: true }] },
      Y: { post: WIDGET_GET },
    }
  );
  assert.equal(typeof indexSpec(current).unreadable, 'string');
});

test('path-level parameters on a $ref-resolved path item are inherited by its operations', () => {
  const spec = widgetDoc(
    { $ref: '#/components/pathItems/Widget' },
    { Widget: { parameters: [{ name: 'id', in: 'path', required: true }], get: WIDGET_GET } }
  );
  const indexed = indexSpec(spec);
  const widgetOp = indexed.operations.get('GET /widgets/{id}');
  assert.ok(widgetOp);
  const view = parameters(widgetOp.raw, widgetOp.pathItem, indexed.raw);
  assert.ok(view.params.has('path:id'));
});

test('an x- extension under paths shaped like a $ref is not read as a path item', () => {
  const spec = {
    openapi: '3.1.0',
    info: { title: 't', version: 'v' },
    paths: { '/ping': { get: PING_GET }, 'x-metadata': { $ref: 'metadata.json' } },
  };
  const indexed = indexSpec(spec);
  assert.equal(indexed.unreadable, undefined);
  assert.ok(indexed.operations.has('GET /ping'));
  const result = run(spec, spec, [{ method: 'GET', path: '/ping' }]);
  assert.deepEqual(result.findings, []);
});

/* ── a $ref pointer whose fragment percent-encodes reserved characters resolves ──
 *
 * Follow-up review, 2026-09-30 (codat.io sync-for-commerce, real spec): a
 * `$ref` that points at a `paths` key containing a path-parameter brace, e.g.
 * `#/paths/~1meta~1companies~1%7BcompanyId%7D~1connections/parameters/0`, is
 * legal per RFC 6901 §6 — `{` and `}` are reserved in a URI fragment, so a
 * spec generator percent-encodes them (`%7B`/`%7D`) on top of the ordinary
 * `~1`/`~0` JSON Pointer escaping. `deref` used to unescape only `~1`/`~0`
 * and never decode the percent-encoding, so this ref's segment never matched
 * the document's literal `{companyId}` key, `deref` reported "does not
 * resolve", and the referenced parameter fell into `unknowns` — invisible to
 * comparison. In the real document this made the OLD side's `companyId`
 * path parameter disappear, so the diff reported it as newly added and
 * required.
 */
test('deref resolves a $ref fragment that percent-encodes braces in a path key', () => {
  const doc: Json = {
    paths: {
      '/meta/companies/{companyId}/connections': {
        parameters: [{ name: 'companyId', in: 'path', required: true, schema: { type: 'string' } }],
      },
    },
  };
  const ref = '#/paths/~1meta~1companies~1%7BcompanyId%7D~1connections/parameters/0';
  const result = deref({ $ref: ref }, doc);
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.node : null, { name: 'companyId', in: 'path', required: true, schema: { type: 'string' } });
});

test('deref still refuses a $ref with a malformed percent sequence rather than throwing', () => {
  const doc: Json = { paths: { '/x': { get: {} } } };
  const result = deref({ $ref: '#/paths/~1x%/get' }, doc);
  // "%" alone is not a valid percent-encoding; decodeURIComponent throws.
  assert.equal(result.ok, false);
});

/* ── round-2 follow-up review, 2026-09-30 ──
 *
 * Two corrections to the fix above:
 *
 * 1. Percent-decode the WHOLE fragment first, THEN split on "/" and unescape
 *    "~1"/"~0" — not the reverse. RFC 6901 §6 builds a URI fragment by
 *    escaping the JSON Pointer with "~0"/"~1" first and percent-encoding the
 *    RESULT second, so recovering it runs those two steps in reverse:
 *    percent-decode, then split-and-unescape. Decoding each already-split
 *    segment on its own (the round-1 fix) gives the same answer for the
 *    common case (only reserved characters like "{"/"}" inside a token are
 *    percent-encoded) but is wrong whenever a generator percent-encodes a
 *    structural "/" as "%2F" instead of leaving it as a literal separator —
 *    decode-per-segment never sees a "/" to split on, decode-whole-first
 *    does.
 * 2. Malformed percent-encoding must fail EXPLICITLY (a named reason), not
 *    fall back to using the raw, undecoded text — falling back can resolve
 *    to the wrong node instead of refusing.
 */
test('deref percent-decodes the WHOLE fragment before splitting it into pointer segments', () => {
  // The structural "/" between "a" and "b" is itself percent-encoded as
  // "%2F". Per-segment decoding (split first) never encounters a real "/"
  // to split on, so it looks for one flat key "a/b" and fails. Decoding the
  // fragment as a whole first recovers the real pointer "/a/b" before
  // splitting, and resolves through the nested "a" -> "b".
  const doc: Json = { a: { b: 'VALUE' } };
  const result = deref({ $ref: '#/a%2Fb' }, doc);
  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.node : null, 'VALUE');
});

test('deref names malformed percent-encoding explicitly, rather than silently using the raw text', () => {
  const doc: Json = { paths: { '/x%': { get: {} } } };
  const result = deref({ $ref: '#/paths/~1x%' }, doc);
  assert.equal(result.ok, false);
  assert.equal(result.ok ? '' : /percent-encod/i.test(result.reason), true);
});

/* ── round-4 follow-up review, 2026-09-30 (bullet 7) ──
 *
 * Locality (is this ref local at all?) must be decided on the RAW,
 * still-encoded ref text — does it start with "#"? — before any decoding.
 * Judging pointer *shape* (does it look like "#/...") on the raw text
 * instead used to reject a validly percent-encoded local ref whose leading
 * "/" was itself encoded: `#%2Fcomponents%2Fschemas%2FX` does not start
 * with the literal text "#/", but decodes to the perfectly ordinary pointer
 * "#/components/schemas/X". Shape is only checked AFTER decoding.
 */
test('deref resolves a local ref whose leading slash is itself percent-encoded', () => {
  const doc: Json = { components: { schemas: { X: { type: 'string' } } } };
  const result = deref({ $ref: '#%2Fcomponents%2Fschemas%2FX' }, doc);
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.node : null, { type: 'string' });
});

test('deref still refuses a ref that does not start with "#" at all — a remote reference', () => {
  const doc: Json = { components: { schemas: { X: { type: 'string' } } } };
  const result = deref({ $ref: 'other.yaml#/components/schemas/X' }, doc);
  assert.equal(result.ok, false);
  assert.equal(result.ok ? '' : /points outside this document/.test(result.reason), true);
});

/* ── round-2 follow-up review, 2026-09-30: a failed $ref never becomes a silent null type/enum ──
 *
 * `typeOfSchema`/`enumOfSchema` used to return `null` both when a schema
 * genuinely declares no type/enum AND when its `$ref` could not be resolved
 * — the caller in `diff.ts` cannot tell "nothing to report" from "could not
 * read this side at all" apart, so an unresolved ref hid changes in BOTH
 * directions:
 *   - a NEW-side ref that fails to resolve reads as "no type," so a real
 *     type change (was `wasType`, now unreadable) never gets reported at all;
 *   - an OLD-side ref that fails to resolve reads as "no enum," so a
 *     genuinely-enumerated new side reads as a false `enum_now_restricted` —
 *     inventing a finding about a change that was never actually observed on
 *     the old side, because the old side could not be read.
 * Either side failing to resolve must surface as `not_compared`, not a guess.
 */
// Round-5 review, P2 (bullet 3): an operation-level parameter override
// shadows an otherwise-fine path-level parameter of the same name, but the
// override's OWN schema contains an unresolved $ref. Its required-ness IS
// technically readable straight off the override object (`required: true`)
// — but the parameter's true effective shape cannot be honestly compared at
// all when part of it is unreadable, so EVERY comparison for this one
// parameter (required-ness, enum, type) must be withheld — not just the
// type/enum checks that already fail independently via their own schema
// probes. This is parameter-level granularity, distinct from round 4's #5
// fix, which withheld only required-ness, and only operation-wide, when the
// BASELINE's parameter set could not be read AT ALL (a $ref to the
// parameter object itself failing to resolve).
test('an operation-level override whose own schema is unresolved suppresses every comparison for that parameter, not just type/enum', () => {
  const pathLevelParam = [{ name: 'foo', in: 'query', required: false, schema: { type: 'string' } }];
  const overrideParam = [{ name: 'foo', in: 'query', required: true, schema: { $ref: '#/components/schemas/Missing' } }];
  const before = op({ body: obj({}) });
  const after = op({ body: obj({}), params: overrideParam });
  const result = run(doc(before, pathLevelParam), doc(after, pathLevelParam));
  assert.equal(kinds(result).includes('parameter_now_required'), false);
  assert.equal(kinds(result).filter((k) => k === 'not_compared').length >= 1, true);
});

// The suppression is scoped to just this parameter — an ordinary, fully
// readable parameter on the same operation still reports normally.
test('the per-parameter unreadable suppression does not leak to a sibling parameter that IS fully readable', () => {
  const before = op({
    body: obj({}),
    params: [
      { name: 'foo', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'bar', in: 'query', required: false, schema: { type: 'string' } },
    ],
  });
  const after = op({
    body: obj({}),
    params: [
      { name: 'foo', in: 'query', required: true, schema: { $ref: '#/components/schemas/Missing' } },
      { name: 'bar', in: 'query', required: true, schema: { type: 'string' } },
    ],
  });
  const result = run(doc(before), doc(after));
  assert.equal(result.findings.some((f) => f.kind === 'parameter_now_required' && f.detail.includes('"bar"')), true);
  assert.equal(result.findings.some((f) => f.kind === 'parameter_now_required' && f.detail.includes('"foo"')), false);
});

test('round-2 bug 2: an unresolved $ref on the NEW side of a parameter schema is not_compared, never a silent skip', () => {
  const before = op({ params: [{ name: 'id', in: 'query', schema: { type: 'string' } }] });
  const after = op({ params: [{ name: 'id', in: 'query', schema: { $ref: '#/components/schemas/Missing' } }] });
  const result = run(doc(before), doc(after));
  assert.equal(kinds(result).includes('not_compared'), true);
  assert.equal(kinds(result).includes('field_type_changed'), false);
});

test('round-2 bug 2: an unresolved $ref on the OLD side of a parameter schema is not_compared, never a false enum_now_restricted', () => {
  const before = op({ params: [{ name: 'id', in: 'query', schema: { $ref: '#/components/schemas/Missing' } }] });
  const after = op({ params: [{ name: 'id', in: 'query', schema: { type: 'string', enum: ['a', 'b'] } }] });
  const result = run(doc(before), doc(after));
  assert.equal(kinds(result).includes('not_compared'), true);
  assert.equal(kinds(result).includes('enum_now_restricted'), false);
});
