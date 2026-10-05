import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffEndpoints } from '../src/diff.js';
import { indexSpec } from '../src/spec.js';
import type { EndpointRef, Finding } from '../src/types.js';

function doc(path: string, method: string, op: Record<string, unknown>): unknown {
  return {
    openapi: '3.0.0',
    info: { title: 't', version: 'v' },
    paths: { [path]: { [method]: op } },
  };
}

function docWithComponents(
  path: string,
  method: string,
  op: Record<string, unknown>,
  components: Record<string, unknown>
): unknown {
  return {
    openapi: '3.0.0',
    info: { title: 't', version: 'v' },
    paths: { [path]: { [method]: op } },
    components,
  };
}

function twoPathDoc(
  a: { endpoint: EndpointRef; op: Record<string, unknown> },
  b: { endpoint: EndpointRef; op: Record<string, unknown> }
): unknown {
  return {
    openapi: '3.0.0',
    info: { title: 't', version: 'v' },
    paths: {
      [a.endpoint.path]: { [a.endpoint.method.toLowerCase()]: a.op },
      [b.endpoint.path]: { [b.endpoint.method.toLowerCase()]: b.op },
    },
  };
}

interface OpOpts {
  body?: unknown;
  response?: unknown;
  deprecated?: boolean;
  parameters?: unknown[];
}

function opWith(opts: OpOpts): Record<string, unknown> {
  const op: Record<string, unknown> = { responses: {} };
  if (opts.deprecated !== undefined) op.deprecated = opts.deprecated;
  if (opts.body !== undefined) {
    op.requestBody = {
      required: true,
      content: { 'application/json': { schema: opts.body } },
    };
  }
  if (opts.response !== undefined) {
    op.responses = {
      '200': {
        description: 'ok',
        content: { 'application/json': { schema: opts.response } },
      },
    };
  }
  if (opts.parameters !== undefined) op.parameters = opts.parameters;
  return op;
}

function run(baseline: unknown, current: unknown, endpoints: EndpointRef[]): ReturnType<typeof diffEndpoints> {
  return diffEndpoints({
    vendor: 'vendor',
    baseline: indexSpec(baseline),
    current: indexSpec(current),
    endpoints,
  });
}

/**
 * Indexing `findings[0]` directly is not type-safe under
 * noUncheckedIndexedAccess, and a test that quietly compares `undefined`
 * against a string passes for the wrong reason, so every lookup goes through
 * here and fails loudly when there is nothing to look at.
 */
function firstFinding(result: { findings: Finding[] }): Finding {
  const finding = result.findings[0];
  assert.ok(finding, 'expected at least one finding');
  return finding;
}

const EP: EndpointRef = { method: 'POST', path: '/v1/things' };
const EP2: EndpointRef = { method: 'GET', path: '/v2/other' };

function kindsOf(result: ReturnType<typeof diffEndpoints>): string[] {
  return result.findings.map((f: Finding) => f.kind);
}

test('two identical specs with one declared endpoint produce no findings and count one endpoint checked', () => {
  const op = opWith({ body: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } });
  const result = run(doc(EP.path, 'post', op), doc(EP.path, 'post', op), [EP]);
  assert.deepEqual(result.findings, []);
  assert.equal(result.endpointsChecked, 1);
  assert.equal(result.endpointsSkipped, 0);
});

// Round-4: DiffInput.serverChanged / DiffInput.ambiguous (populated by
// diff-cli.ts from alignPaths — see match-endpoints.test.ts for how they get
// set) are consumed here, before the operation's body/parameters are
// compared at all, so the finding is never wrongly demoted to breaking or
// silently skipped as if the operation were unchanged.
test('a serverChanged endpoint gets exactly one unknown server_changed finding, body and params never compared', () => {
  const before = opWith({ body: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } });
  const after = opWith({}); // a real, would-be-breaking removal if compared
  const result = diffEndpoints({
    vendor: 'v',
    baseline: indexSpec(doc(EP.path, 'post', before)),
    current: indexSpec(doc(EP.path, 'post', after)),
    endpoints: [EP],
    serverChanged: new Set([`${EP.method} ${EP.path}`]),
  });
  assert.equal(result.findings.length, 1);
  assert.equal(firstFinding(result).kind, 'server_changed');
  assert.equal(firstFinding(result).severity, 'unknown');
});

test('an ambiguous endpoint gets exactly one unknown finding, never breaking and never silently unchanged', () => {
  const before = opWith({ body: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } });
  const after = opWith({});
  const result = diffEndpoints({
    vendor: 'v',
    baseline: indexSpec(doc(EP.path, 'post', before)),
    current: indexSpec(doc(EP.path, 'post', after)),
    endpoints: [EP],
    ambiguous: new Set([`${EP.method} ${EP.path}`]),
  });
  assert.equal(result.findings.length, 1);
  assert.equal(firstFinding(result).kind, 'unknown');
  assert.equal(firstFinding(result).severity, 'unknown');
});

// Round-5: DiffInput.possiblyMoved (populated by alignPaths — see
// match-endpoints.test.ts) pairs an operation unmatched on the baseline side
// with one unmatched on the current side. Both endpoints must produce
// exactly ONE `possibly_moved`/`unknown` finding between them — never the
// baseline's `operation_removed` plus the current's `endpoint_not_in_
// baseline`/addition that an ordinary union-of-endpoints pass would produce.
test('a possiblyMoved pair produces exactly one unknown possibly_moved finding, not a removal plus an addition', () => {
  const oldEp: EndpointRef = { method: 'GET', path: '/pets' };
  const newEp: EndpointRef = { method: 'GET', path: '/v1/pets' };
  const result = diffEndpoints({
    vendor: 'v',
    baseline: indexSpec(doc(oldEp.path, 'get', opWith({}))),
    current: indexSpec(doc(newEp.path, 'get', opWith({}))),
    endpoints: [oldEp, newEp],
    possiblyMoved: new Map([
      [`${oldEp.method} ${oldEp.path}`, `${newEp.method} ${newEp.path}`],
      [`${newEp.method} ${newEp.path}`, `${oldEp.method} ${oldEp.path}`],
    ]),
  });
  assert.equal(result.findings.length, 1);
  assert.equal(firstFinding(result).kind, 'possibly_moved');
  assert.equal(firstFinding(result).severity, 'unknown');
  assert.equal(kindsOf(result).includes('operation_removed'), false);
  assert.equal(kindsOf(result).includes('endpoint_not_in_baseline'), false);
});

test('an operation removed from the current spec is a breaking operation_removed finding', () => {
  const op = opWith({});
  const result = run(doc(EP.path, 'post', op), doc('/v1/other', 'post', opWith({})), [EP]);
  assert.equal(result.findings.length, 1);
  assert.equal(firstFinding(result).kind, 'operation_removed');
  assert.equal(firstFinding(result).severity, 'breaking');
});

test('an operation that gains deprecated is a deprecation finding', () => {
  const before = opWith({});
  const after = opWith({ deprecated: true });
  const result = run(doc(EP.path, 'post', before), doc(EP.path, 'post', after), [EP]);
  assert.equal(result.findings.length, 1);
  assert.equal(firstFinding(result).kind, 'operation_deprecated');
  assert.equal(firstFinding(result).severity, 'deprecation');
});

test('an operation already deprecated in the baseline produces no deprecation finding, because it is not news', () => {
  const before = opWith({ deprecated: true });
  const after = opWith({ deprecated: true });
  const result = run(doc(EP.path, 'post', before), doc(EP.path, 'post', after), [EP]);
  assert.deepEqual(result.findings, []);
});

test('a request body property added to required is a request_field_now_required finding naming the field', () => {
  const before = opWith({ body: { type: 'object', properties: { a: { type: 'string' } } } });
  const after = opWith({ body: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } });
  const result = run(doc(EP.path, 'post', before), doc(EP.path, 'post', after), [EP]);
  assert.equal(result.findings.length, 1);
  assert.equal(firstFinding(result).kind, 'request_field_now_required');
  assert.ok(firstFinding(result).detail.includes('"a"'));
});

test('a request body property removed from the current schema is a request_field_removed finding', () => {
  const before = opWith({ body: { type: 'object', properties: { a: { type: 'string' } } } });
  const after = opWith({ body: { type: 'object', properties: {} } });
  const result = run(doc(EP.path, 'post', before), doc(EP.path, 'post', after), [EP]);
  assert.equal(result.findings.length, 1);
  assert.equal(firstFinding(result).kind, 'request_field_removed');
});

test('a request property added that is not required produces no findings and counts as additive', () => {
  const before = opWith({ body: { type: 'object', properties: {} } });
  const after = opWith({ body: { type: 'object', properties: { b: { type: 'string' } } } });
  const result = run(doc(EP.path, 'post', before), doc(EP.path, 'post', after), [EP]);
  assert.deepEqual(result.findings, []);
  assert.equal(result.additiveChanges, 1);
});

test('a parameter that becomes required is a parameter_now_required finding', () => {
  const before = opWith({ parameters: [{ name: 'q', in: 'query', required: false, schema: { type: 'string' } }] });
  const after = opWith({ parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' } }] });
  const result = run(doc(EP.path, 'post', before), doc(EP.path, 'post', after), [EP]);
  assert.equal(result.findings.length, 1);
  assert.equal(firstFinding(result).kind, 'parameter_now_required');
});

test('a parameter required in both specs produces no findings', () => {
  const before = opWith({ parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' } }] });
  const after = opWith({ parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' } }] });
  const result = run(doc(EP.path, 'post', before), doc(EP.path, 'post', after), [EP]);
  assert.deepEqual(result.findings, []);
});

// PROTECTS: a removed response field is the change that silently breaks a caller's parser.
test('a 200 response property removed is a breaking response_field_removed finding', () => {
  const before = opWith({ response: { type: 'object', properties: { id: { type: 'string' } } } });
  const after = opWith({ response: { type: 'object', properties: {} } });
  const result = run(doc(EP.path, 'post', before), doc(EP.path, 'post', after), [EP]);
  assert.equal(result.findings.length, 1);
  assert.equal(firstFinding(result).kind, 'response_field_removed');
  assert.equal(firstFinding(result).severity, 'breaking');
});

test('an enum member removed from a shared request property is an enum_value_removed finding quoting the value', () => {
  const before = opWith({
    body: { type: 'object', properties: { mode: { type: 'string', enum: ['a', 'b'] } } },
  });
  const after = opWith({
    body: { type: 'object', properties: { mode: { type: 'string', enum: ['b'] } } },
  });
  const result = run(doc(EP.path, 'post', before), doc(EP.path, 'post', after), [EP]);
  assert.equal(result.findings.length, 1);
  assert.equal(firstFinding(result).kind, 'enum_value_removed');
  assert.ok(firstFinding(result).detail.includes('"a"'));
});

test('an enum member added with none removed produces no findings and counts as additive', () => {
  const before = opWith({
    body: { type: 'object', properties: { mode: { type: 'string', enum: ['a'] } } },
  });
  const after = opWith({
    body: { type: 'object', properties: { mode: { type: 'string', enum: ['a', 'b'] } } },
  });
  const result = run(doc(EP.path, 'post', before), doc(EP.path, 'post', after), [EP]);
  assert.deepEqual(result.findings, []);
  assert.equal(result.additiveChanges, 1);
});

// PROTECTS: a manifest typo must never read as safety.
test('a declared endpoint absent from the baseline but present in the current spec is an unknown endpoint_not_in_baseline finding', () => {
  const op = opWith({});
  const result = run(doc('/v1/other', 'post', op), doc(EP.path, 'post', op), [EP]);
  assert.equal(result.findings.length, 1);
  assert.equal(firstFinding(result).kind, 'endpoint_not_in_baseline');
  assert.equal(firstFinding(result).severity, 'unknown');
  assert.equal(result.endpointsSkipped, 1);
  assert.equal(result.endpointsChecked, 0);
});

test('a declared endpoint absent from both specs is an endpoint_not_in_baseline finding that names it and points at the path template', () => {
  const op = opWith({});
  const result = run(doc('/v1/other', 'post', op), doc('/v1/other', 'post', op), [EP]);
  assert.equal(result.findings.length, 1);
  assert.equal(firstFinding(result).kind, 'endpoint_not_in_baseline');
  // The endpoint is its own field, so the detail says what to do about it rather
  // than repeating the path the report already prints in its own column.
  assert.equal(firstFinding(result).endpoint, `${EP.method} ${EP.path}`);
  assert.ok(firstFinding(result).detail.includes('path template'));
  assert.ok(firstFinding(result).detail.includes('either spec'));
});

// PROTECTS: an unreadable shape is reported, never guessed at.
test('a top-level oneOf request schema in the current spec yields a not_compared finding at requestBody and no request_field findings', () => {
  const before = opWith({ body: { type: 'object', properties: { a: { type: 'string' } } } });
  const after = opWith({
    body: {
      oneOf: [
        { type: 'object', properties: { a: { type: 'string' } } },
        { type: 'object', properties: { b: { type: 'string' } } },
      ],
    },
  });
  const result = run(doc(EP.path, 'post', before), doc(EP.path, 'post', after), [EP]);
  const unknowns = result.findings.filter((f) => f.kind === 'not_compared');
  assert.equal(unknowns.length, 1);
  assert.equal(firstFinding({ findings: unknowns }).at, 'requestBody');
  assert.deepEqual(
    result.findings.filter((f) => f.kind.startsWith('request_field_')),
    []
  );
});

// PROTECTS: an allOf intersection is unambiguous, so it is merged rather than refused.
test('a request schema built from allOf where one branch gains a required field is a request_field_now_required finding', () => {
  const before = opWith({
    body: {
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } } },
        { type: 'object', properties: { b: { type: 'string' } } },
      ],
    },
  });
  const after = opWith({
    body: {
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        { type: 'object', properties: { b: { type: 'string' } } },
      ],
    },
  });
  const result = run(doc(EP.path, 'post', before), doc(EP.path, 'post', after), [EP]);
  assert.equal(result.findings.length, 1);
  assert.equal(firstFinding(result).kind, 'request_field_now_required');
});

test('a $ref to components/schemas/X present in both specs resolves and a required field added inside X is detected', () => {
  // The operation is identical in both specs; what changes is the component it
  // points at, which is the whole point of the test.
  const op = (): Record<string, unknown> => opWith({ body: { $ref: '#/components/schemas/X' } });
  const before = docWithComponents(EP.path, 'post', op(), {
    schemas: { X: { type: 'object', properties: { a: { type: 'string' } } } },
  });
  const after = docWithComponents(EP.path, 'post', op(), {
    schemas: { X: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } },
  });
  const result = run(before, after, [EP]);
  assert.equal(result.findings.length, 1);
  assert.equal(firstFinding(result).kind, 'request_field_now_required');
});

test('a $ref pointing at a component that does not exist yields a not_compared finding', () => {
  const before = opWith({ body: { type: 'object', properties: { a: { type: 'string' } } } });
  const after = opWith({ body: { $ref: '#/components/schemas/Missing' } });
  const result = run(doc(EP.path, 'post', before), doc(EP.path, 'post', after), [EP]);
  assert.equal(kindsOf(result).includes('not_compared'), true);
});

test('two declared endpoints where one changed and one did not produce exactly one finding with both endpoints checked', () => {
  const changedBefore = opWith({ body: { type: 'object', properties: { a: { type: 'string' } } } });
  const changedAfter = opWith({ body: { type: 'object', properties: {} } });
  const unchanged = opWith({ body: { type: 'object', properties: { keep: { type: 'string' } } } });
  const baseline = twoPathDoc({ endpoint: EP, op: changedBefore }, { endpoint: EP2, op: unchanged });
  const current = twoPathDoc({ endpoint: EP, op: changedAfter }, { endpoint: EP2, op: unchanged });
  const result = run(baseline, current, [EP, EP2]);
  assert.equal(result.findings.length, 1);
  assert.equal(firstFinding(result).endpoint, `${EP.method} ${EP.path}`);
  assert.equal(result.endpointsChecked, 2);
  assert.equal(result.endpointsSkipped, 0);
});

// PROTECTS: a grouped refusal names every path it refused, not three examples,
// so an audit of the exclusion set can hold the report to the full list.
test('a grouped refusal with more than three paths carries the full sorted list in paths', () => {
  const fields = ['a', 'b', 'c', 'd', 'e'];
  const same = Object.fromEntries(fields.map((f) => [f, { type: 'string' }]));
  const different = Object.fromEntries(fields.map((f) => [f, { type: 'number' }]));
  const before = opWith({ body: { type: 'object', properties: same } });
  const after = opWith({
    body: { allOf: [{ type: 'object', properties: same }, { type: 'object', properties: different }] },
  });
  const result = run(doc(EP.path, 'post', before), doc(EP.path, 'post', after), [EP]);
  const finding = result.findings.find((f) => f.kind === 'not_compared');
  assert.ok(finding);
  assert.deepEqual(finding.paths, ['a', 'b', 'c', 'd', 'e']);
  // The detail is unchanged: three examples, then "and elsewhere".
  assert.equal(
    finding.detail,
    '5 fields were not compared in the current spec — two allOf branches define this field differently — at a, b, c and elsewhere'
  );
});

// A single-path refusal puts the path in `at`; a `paths` key on it would be a
// second copy of a fact the report already states.
test('a single-path refusal carries no paths key at all', () => {
  const before = opWith({ body: { type: 'object', properties: { a: { type: 'string' } } } });
  const after = opWith({
    body: {
      oneOf: [
        { type: 'object', properties: { a: { type: 'string' } } },
        { type: 'object', properties: { b: { type: 'string' } } },
      ],
    },
  });
  const result = run(doc(EP.path, 'post', before), doc(EP.path, 'post', after), [EP]);
  const finding = result.findings.find((f) => f.kind === 'not_compared');
  assert.ok(finding);
  assert.equal('paths' in finding, false);
});

// PROTECTS: only topmost paths are listed. A refusal at a parent already
// covers everything under it, so a child in `paths` would double-count.
test('a nested refusal (parent and child both refused) lists only the parent', () => {
  const union = { anyOf: [{ type: 'string' }, { type: 'number' }] };
  const before = opWith({
    body: {
      type: 'object',
      properties: { p: { type: 'string' }, q: { type: 'string' }, r: { type: 'string' }, s: { type: 'string' } },
    },
  });
  const after = opWith({
    body: {
      type: 'object',
      properties: {
        p: union,
        // A literal dotted key: the refusal at "p.q" is a child of the one at
        // "p", and the parent is the only one of the two that may be listed.
        'p.q': union,
        q: union,
        r: union,
        s: union,
      },
    },
  });
  const result = run(doc(EP.path, 'post', before), doc(EP.path, 'post', after), [EP]);
  const finding = result.findings.find((f) => f.kind === 'not_compared');
  assert.ok(finding);
  assert.deepEqual(finding.paths, ['p', 'q', 'r', 's']);
  assert.equal(finding.paths.includes('p.q'), false);
});

// A union's shape is not compared, but its field is still named, so its
// presence is. Found auditing the splitcheck exclusions on 2026-09-26: the
// payment path reads `customer`, `customer_details`, `payment_intent` and
// `line_items.data[].price`, all anyOf unions in Stripe's spec, and a Session
// that stopped returning any of them used to produce only the standing
// "not compared" line.
const EXPANDABLE = { anyOf: [{ type: 'string' }, { type: 'object', properties: { id: { type: 'string' } } }] };

test('a union-typed response field that disappears is a breaking removal, not only a not_compared line', () => {
  const before = opWith({ response: { type: 'object', properties: { id: { type: 'string' }, customer: EXPANDABLE } } });
  const after = opWith({ response: { type: 'object', properties: { id: { type: 'string' } } } });
  const result = run(doc(EP.path, 'post', before), doc(EP.path, 'post', after), [EP]);
  const removed = result.findings.filter((f) => f.kind === 'response_field_removed');
  assert.equal(removed.length, 1);
  assert.equal(removed[0]?.severity, 'breaking');
  assert.equal(removed[0]?.at, 'response.200.customer');
});

test('a union-typed request field that disappears is a breaking removal', () => {
  const before = opWith({ body: { type: 'object', properties: { a: { type: 'string' }, source: EXPANDABLE } } });
  const after = opWith({ body: { type: 'object', properties: { a: { type: 'string' } } } });
  const result = run(doc(EP.path, 'post', before), doc(EP.path, 'post', after), [EP]);
  assert.deepEqual(
    result.findings.filter((f) => f.kind === 'request_field_removed').map((f) => f.at),
    ['requestBody.source']
  );
});

test('a union field that is still there is not removed, whatever its branches did', () => {
  const before = opWith({ response: { type: 'object', properties: { customer: EXPANDABLE } } });
  const after = opWith({
    response: { type: 'object', properties: { customer: { anyOf: [{ type: 'string' }] } } },
  });
  const result = run(doc(EP.path, 'post', before), doc(EP.path, 'post', after), [EP]);
  assert.deepEqual(kindsOf(result), ['not_compared']);
});

test('a field that became a union in the current spec is not reported as removed', () => {
  const before = opWith({ response: { type: 'object', properties: { customer: { type: 'string' } } } });
  const after = opWith({ response: { type: 'object', properties: { customer: EXPANDABLE } } });
  const result = run(doc(EP.path, 'post', before), doc(EP.path, 'post', after), [EP]);
  assert.deepEqual(kindsOf(result), ['not_compared']);
});

// Found by the 2026-09-26 Codex review: `list[]` is an element slot, not a
// named field, so an array whose items stopped being described lost no field.
test('an array whose union items stop being described is not a field removal', () => {
  const before = opWith({ response: { type: 'object', properties: { list: { type: 'array', items: EXPANDABLE } } } });
  const after = opWith({ response: { type: 'object', properties: { list: { type: 'array' } } } });
  const result = run(doc(EP.path, 'post', before), doc(EP.path, 'post', after), [EP]);
  assert.equal(result.findings.filter((f) => f.kind === 'response_field_removed').length, 0);
});

// Regression (0.2.0 verification, 2026-10-04, swagger-petstore 1.0.24 -> 1.0.28):
// "default: successful operation" became "200: successful operation" plus
// "default: Unexpected error". The current spec still declares `default`, so
// "the current spec does not declare a default response" was false, and the
// two success shapes were never compared.
const userSchema = (props: Record<string, unknown>): unknown => ({
  content: { 'application/json': { schema: { type: 'object', properties: props } } },
});
const runResponses = (oldResponses: unknown, newResponses: unknown): Finding[] =>
  diffEndpoints({
    vendor: 'v',
    baseline: indexSpec(doc('/u', 'post', { responses: oldResponses })),
    current: indexSpec(doc('/u', 'post', { responses: newResponses })),
    endpoints: [{ method: 'POST', path: '/u' }],
  }).findings;

test('diff: a lone default success response is paired with a newly explicit 200, not reported withdrawn', () => {
  const findings = runResponses(
    { default: { description: 'successful operation', ...(userSchema({ id: {}, name: {} }) as object) } },
    {
      200: { description: 'successful operation', ...(userSchema({ id: {} }) as object) },
      default: { description: 'Unexpected error' },
    }
  );
  assert.deepEqual(
    findings.map((f) => f.kind),
    ['response_field_removed']
  );
  assert.equal(findings[0]!.at, 'response.default.name');
});

test('diff: an explicit 200 that became a lone default success is paired too', () => {
  const findings = runResponses(
    { 200: { description: 'ok', ...(userSchema({ id: {} }) as object) } },
    { default: { description: 'ok', ...(userSchema({ id: {} }) as object) } }
  );
  assert.deepEqual(findings, []);
});

test('diff: a lone default success split into several 2xx statuses is not compared, not reported removed', () => {
  const findings = runResponses(
    { default: { description: 'ok' } },
    { 200: { description: 'ok' }, 201: { description: 'created' }, default: { description: 'error' } }
  );
  assert.deepEqual(
    findings.map((f) => [f.kind, f.severity]),
    [['not_compared', 'not_compared']]
  );
  assert.match(findings[0]!.detail, /"default" and the other as 200, 201/);
});
