import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  docFromText,
  normalizeSwagger2,
  parseSpecText,
  readSpecTextAtGitRef,
  UNRESOLVED_REQUEST_REF,
  UNRESOLVED_RESPONSE_REF,
} from '../src/load-spec.js';

test('parseSpecText: a .json source is parsed as JSON', () => {
  const result = parseSpecText('spec.json', '{"a": 1}');
  assert.ok(result.ok);
  assert.deepEqual(result.raw, { a: 1 });
});

test('parseSpecText: a .yaml source is parsed as YAML', () => {
  const result = parseSpecText('spec.yaml', 'a: 1\nb: two\n');
  assert.ok(result.ok);
  assert.deepEqual(result.raw, { a: 1, b: 'two' });
});

test('parseSpecText: a .json source that is not JSON is a parse error, not a silent YAML fallback', () => {
  const result = parseSpecText('spec.json', 'a: 1');
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /not valid JSON/);
});

test('parseSpecText: no extension sniffs the content — brace-first reads as JSON', () => {
  const result = parseSpecText('https://example.com/openapi', '{"a": 1}');
  assert.ok(result.ok);
  assert.deepEqual(result.raw, { a: 1 });
});

test('parseSpecText: no extension, not JSON-shaped, falls back to YAML', () => {
  const result = parseSpecText('https://example.com/openapi', 'a: 1\n');
  assert.ok(result.ok);
  assert.deepEqual(result.raw, { a: 1 });
});

test('parseSpecText: unparseable in either format reports an error naming the source', () => {
  const result = parseSpecText('spec', '"unterminated');
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /spec/);
});

test('normalizeSwagger2: leaves an OpenAPI 3 document untouched', () => {
  const doc = { openapi: '3.0.0', paths: { '/x': { get: { responses: {} } } } };
  assert.equal(normalizeSwagger2(doc), doc);
});

test('normalizeSwagger2: a body parameter becomes requestBody.content', () => {
  const doc = {
    swagger: '2.0',
    consumes: ['application/json'],
    paths: {
      '/pets': {
        post: {
          parameters: [{ name: 'body', in: 'body', required: true, schema: { type: 'object', properties: { name: { type: 'string' } } } }],
          responses: { 200: { description: 'ok' } },
        },
      },
    },
  };
  const normalized = normalizeSwagger2(doc) as {
    paths: { '/pets': { post: { parameters: unknown[]; requestBody: { required: boolean; content: Record<string, unknown> } } } };
  };
  const post = normalized.paths['/pets'].post;
  assert.deepEqual(post.parameters, []);
  assert.equal(post.requestBody.required, true);
  assert.deepEqual(Object.keys(post.requestBody.content), ['application/json']);
});

test('normalizeSwagger2: a response schema becomes response.content', () => {
  const doc = {
    swagger: '2.0',
    produces: ['application/json'],
    paths: {
      '/pets': {
        get: {
          responses: { 200: { description: 'ok', schema: { type: 'object' } } },
        },
      },
    },
  };
  const normalized = normalizeSwagger2(doc) as {
    paths: { '/pets': { get: { responses: { '200': { content: Record<string, unknown> } } } } };
  };
  assert.deepEqual(Object.keys(normalized.paths['/pets'].get.responses['200'].content), ['application/json']);
});

// Round-3 follow-up review, 2026-09-30 (bullet 7): a Swagger 2.0 document
// may declare a response once under the top-level `responses` section and
// `$ref` it from an operation, rather than repeating its `schema` inline.
// A still-unresolved `$ref` entry has no `schema` key of its own, so the
// schema->content conversion below used to skip it entirely — the response
// stayed a bare `{ $ref: '#/responses/NotFound' }`, and the shared
// definition it points to was never converted either, since normalization
// only walks `paths`. The $ref must resolve BEFORE the conversion runs.
test('normalizeSwagger2: a response $ref into the top-level #/responses section is resolved and converted to content', () => {
  const doc = {
    swagger: '2.0',
    responses: { NotFound: { description: 'not found', schema: { type: 'object', properties: { error: { type: 'string' } } } } },
    paths: {
      '/pets/{id}': {
        get: { responses: { '404': { $ref: '#/responses/NotFound' } } },
      },
    },
  };
  const normalized = normalizeSwagger2(doc) as {
    paths: { '/pets/{id}': { get: { responses: { '404': { content?: Record<string, unknown>; schema?: unknown; $ref?: unknown } } } } };
  };
  const resolved = normalized.paths['/pets/{id}'].get.responses['404'];
  assert.equal(resolved.$ref, undefined);
  assert.deepEqual(Object.keys(resolved.content ?? {}), ['application/json']);
});

// Same rule for a shared `#/parameters/Name` body parameter: a still-
// unresolved $ref entry has no `in` property, so it was invisible to the
// body-parameter search and never became `requestBody` at all.
test('normalizeSwagger2: a body parameter $ref into the top-level #/parameters section is resolved into requestBody', () => {
  const doc = {
    swagger: '2.0',
    parameters: { PetBody: { name: 'pet', in: 'body', required: true, schema: { type: 'object' } } },
    paths: {
      '/pets': {
        post: { parameters: [{ $ref: '#/parameters/PetBody' }], responses: {} },
      },
    },
  };
  const normalized = normalizeSwagger2(doc) as {
    paths: {
      '/pets': { post: { parameters: unknown[]; requestBody?: { required: boolean; content: Record<string, unknown> } } };
    };
  };
  const op = normalized.paths['/pets'].post;
  assert.ok(op.requestBody);
  assert.equal(op.requestBody?.required, true);
  assert.deepEqual(Object.keys(op.requestBody?.content ?? {}), ['application/json']);
  assert.deepEqual(op.parameters, []);
});

// Round-5 review, P1 (bullet 2): a Swagger 2 non-body parameter (`in:
// query|path|header|formData`) keeps its type constraints — `type`, `enum`,
// `format`, `items`, `minimum`, `maximum`, `default`, etc, the "Items
// Object" keywords — INLINE on the parameter object itself; only `in: body`
// nests them under `schema` (an OpenAPI 3 convention). Without synthesizing
// a `schema` object for a non-body parameter, spec.ts's `typeOfSchema`/
// `enumOfSchema` (which read a parameter's `.schema`) see nothing at all.
test('normalizeSwagger2: an operation-level non-body parameter gets a synthesized schema from its inline constraints', () => {
  const doc = {
    swagger: '2.0',
    paths: {
      '/pets': {
        get: {
          parameters: [{ name: 'mode', in: 'query', type: 'string', enum: ['fast', 'slow'] }],
          responses: {},
        },
      },
    },
  };
  const normalized = normalizeSwagger2(doc) as {
    paths: { '/pets': { get: { parameters: Array<{ name: string; schema?: { type?: string; enum?: string[] } }> } } };
  };
  const param = normalized.paths['/pets'].get.parameters[0];
  assert.ok(param);
  assert.deepEqual(param?.schema, { type: 'string', enum: ['fast', 'slow'] });
});

test('normalizeSwagger2: a path-item-level non-body parameter also gets a synthesized schema from its inline constraints', () => {
  const doc = {
    swagger: '2.0',
    paths: {
      '/pets/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, type: 'string' }],
        get: { responses: {} },
      },
    },
  };
  const normalized = normalizeSwagger2(doc) as {
    paths: { '/pets/{id}': { parameters: Array<{ name: string; schema?: { type?: string } }> } };
  };
  const param = normalized.paths['/pets/{id}'].parameters[0];
  assert.ok(param);
  assert.deepEqual(param?.schema, { type: 'string' });
});

// A Swagger 2 `in: body` parameter's `schema` is untouched — it is already
// exactly the shape this synthesis exists to produce for everyone else.
test('normalizeSwagger2: a body parameter is not touched by the non-body schema synthesis', () => {
  const doc = {
    swagger: '2.0',
    paths: {
      '/pets': {
        post: {
          parameters: [{ name: 'body', in: 'body', required: true, schema: { type: 'object' } }],
          responses: {},
        },
      },
    },
  };
  const normalized = normalizeSwagger2(doc) as {
    paths: { '/pets': { post: { requestBody: { content: Record<string, { schema: unknown }> } } } };
  };
  assert.deepEqual(normalized.paths['/pets'].post.requestBody.content['application/json']?.schema, { type: 'object' });
});

// End to end: the Swagger 2 fixture the coordinator's repro describes — a
// query parameter `mode` whose enum narrows from two values to one — must
// actually produce a finding, not silence. `enumOfSchema` reading the
// synthesized `schema` (spec.ts) sees this exactly like an OpenAPI 3
// parameter with the same shape, and diff.ts's existing enum-narrowing rule
// for a NON-null baseline enum shrinking to a NON-null current enum is
// `enum_value_removed` (see diff.ts's `wasEnum !== null && isEnum !== null`
// branch) — `enum_now_restricted` is specifically "was unrestricted, now
// restricted", which this is not.
test('a Swagger 2 query parameter enum narrowing from two values to one is enum_value_removed, end to end', async () => {
  const { diffEndpoints } = await import('../src/diff.js');
  const { parameters } = await import('../src/spec.js');
  const swaggerDoc = (enumValues: string[]): unknown => ({
    swagger: '2.0',
    paths: {
      '/pets': {
        get: {
          parameters: [{ name: 'mode', in: 'query', type: 'string', enum: enumValues }],
          responses: { 200: { description: 'ok' } },
        },
      },
    },
  });
  const before = docFromText('a.json', JSON.stringify(swaggerDoc(['fast', 'slow'])));
  const after = docFromText('b.json', JSON.stringify(swaggerDoc(['fast'])));
  assert.ok(before.ok && after.ok);
  if (!before.ok || !after.ok) return;

  // Sanity: the synthesis actually reaches spec.ts's own parameter reader.
  const beforeOp = before.doc.operations.get('GET /pets');
  assert.ok(beforeOp);
  if (beforeOp) {
    const params = parameters(beforeOp.raw, beforeOp.pathItem, before.doc.raw);
    assert.deepEqual(params.params.get('query:mode')?.schema, { type: 'string', enum: ['fast', 'slow'] });
  }

  const result = diffEndpoints({
    vendor: 'v',
    baseline: before.doc,
    current: after.doc,
    endpoints: [{ method: 'GET', path: '/pets' }],
  });
  const enumFinding = result.findings.find((f) => f.kind === 'enum_value_removed');
  assert.ok(enumFinding, `expected enum_value_removed, got ${JSON.stringify(result.findings.map((f) => f.kind))}`);
  assert.equal(enumFinding?.severity, 'breaking');
  assert.match(enumFinding?.detail ?? '', /no longer accepts "slow"/);
});

// Round-4 follow-up review, 2026-09-30 (bullet 4): the bespoke single-segment
// resolver used to only understand a `$ref` shaped exactly like
// `#/responses/Name` or `#/parameters/Name`, and left anything else — a
// dangling reference to a name that is not there — unresolved AND silently
// unconverted, which downstream could later resolve successfully (but
// wrongly, against the un-converted Swagger 2 shape) at read time against the
// full raw document. A $ref that fails to resolve must be reported, not left
// to be silently misread later.
test('normalizeSwagger2: a response $ref that does not resolve is marked, not silently left unconverted', () => {
  const doc = {
    swagger: '2.0',
    responses: { NotFound: { description: 'not found', schema: { type: 'object' } } },
    paths: {
      '/pets/{id}': {
        get: { responses: { '404': { $ref: '#/responses/DoesNotExist' } } },
      },
    },
  };
  const normalized = normalizeSwagger2(doc) as {
    paths: { '/pets/{id}': { get: { responses: { '404': Record<string, unknown> } } } };
  };
  const resolved = normalized.paths['/pets/{id}'].get.responses['404'];
  assert.equal(typeof resolved[UNRESOLVED_RESPONSE_REF], 'string');
  assert.equal(resolved.content, undefined);
});

test('normalizeSwagger2: a body parameter $ref that does not resolve marks the whole operation, not a silently missing request body', () => {
  const doc = {
    swagger: '2.0',
    parameters: { PetBody: { name: 'pet', in: 'body', required: true, schema: { type: 'object' } } },
    paths: {
      '/pets': {
        post: { parameters: [{ $ref: '#/parameters/DoesNotExist' }], responses: {} },
      },
    },
  };
  const normalized = normalizeSwagger2(doc) as {
    paths: { '/pets': { post: Record<string, unknown> } };
  };
  const op = normalized.paths['/pets'].post;
  assert.equal(typeof op[UNRESOLVED_REQUEST_REF], 'string');
  assert.equal(op.requestBody, undefined);
});

// End-to-end: the marker load-spec.ts leaves on an unresolved Swagger 2 $ref
// must actually be read by diff.ts and turned into `not_compared`, not just
// sit unread on the operation.
test('an unresolved Swagger 2 response $ref reaches diff.ts as not_compared, end to end', async () => {
  const { diffEndpoints } = await import('../src/diff.js');
  const doc = {
    swagger: '2.0',
    paths: {
      '/pets/{id}': {
        get: { responses: { '200': { $ref: '#/responses/DoesNotExist' } } },
      },
    },
  };
  const before = docFromText('a.json', JSON.stringify(doc));
  const after = docFromText('b.json', JSON.stringify(doc));
  assert.ok(before.ok && after.ok);
  if (!before.ok || !after.ok) return;
  const result = diffEndpoints({
    vendor: 'v',
    baseline: before.doc,
    current: after.doc,
    endpoints: [{ method: 'GET', path: '/pets/{id}' }],
  });
  assert.ok(result.findings.some((f) => f.kind === 'not_compared'));
  assert.equal(result.findings.some((f) => f.severity === 'breaking'), false);
});

test('normalizeSwagger2: $refs into #/definitions still resolve after normalization', () => {
  const doc = {
    swagger: '2.0',
    definitions: { Pet: { type: 'object', properties: { id: { type: 'string' } } } },
    paths: {
      '/pets': {
        post: {
          parameters: [{ name: 'body', in: 'body', required: true, schema: { $ref: '#/definitions/Pet' } }],
          responses: { 200: { description: 'ok', schema: { $ref: '#/definitions/Pet' } } },
        },
      },
    },
  };
  const doc1 = docFromText('a.json', JSON.stringify(doc));
  assert.ok(doc1.ok);
  const op = doc1.doc.operations.get('POST /pets');
  assert.ok(op);
});

// Regression (P1, bug 6): `git show <rev>:<path>` resolves `<path>` against
// the repository root, not the caller's cwd. Passing a bare relative CLI
// argument straight through used to read the historical file at the repo
// root while the working-tree read (ordinary fs, cwd-relative) picked up the
// subdirectory's copy — two different files compared as if they were one.
test('readSpecTextAtGitRef: resolves a relative path against the repo root when run from a subdirectory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apibreak-loadspec-gitrepo-'));
  const run = (cmd: string[]): void => {
    execFileSync(cmd[0]!, cmd.slice(1), { cwd: dir, stdio: 'pipe' });
  };
  run(['git', 'init', '-q']);
  run(['git', 'config', 'user.email', 'test@example.com']);
  run(['git', 'config', 'user.name', 'Test']);

  const subdir = join(dir, 'services', 'api');
  mkdirSync(subdir, { recursive: true });
  writeFileSync(join(dir, 'openapi.json'), JSON.stringify({ decoy: true }));
  const specPath = join(subdir, 'openapi.json');
  writeFileSync(specPath, JSON.stringify({ real: 'subdir-copy' }));
  run(['git', 'add', '-A']);
  run(['git', 'commit', '-q', '-m', 'baseline']);

  // Called with cwd = the subdirectory and a bare relative path, exactly as
  // `diff-cli.ts` calls it for `--base-ref`.
  const result = await readSpecTextAtGitRef('HEAD', specPath, subdir);
  assert.ok(result.ok);
  if (result.ok) assert.deepEqual(JSON.parse(result.text), { real: 'subdir-copy' });
});

test('readSpecTextAtGitRef: a path outside the repository is refused, not silently read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apibreak-loadspec-gitrepo-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const outside = mkdtempSync(join(tmpdir(), 'apibreak-loadspec-outside-'));
  const outsidePath = join(outside, 'openapi.json');
  writeFileSync(outsidePath, '{}');

  const result = await readSpecTextAtGitRef('HEAD', outsidePath, dir);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /outside the git repository/);
});
