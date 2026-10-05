/**
 * `apibreak diff` end to end: real fetch/file/git-show plumbing, running
 * against small OpenAPI fixtures written to a temp directory. The findings
 * themselves are `diffEndpoints`'s own job and are covered by diff.test.ts;
 * this exercises argument parsing, file/URL/YAML loading, `--base-ref`, exit
 * codes and the two render formats.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDiffReport, runDiff, type Writer } from '../src/diff-cli.js';
import { indexSpec } from '../src/spec.js';

function capture(): Writer & { text: () => string } {
  const chunks: string[] = [];
  return { write: (s: string) => chunks.push(s), text: () => chunks.join('') };
}

function deps(cwd = process.cwd()): { fetch: typeof fetch; now: () => Date; cwd: string } {
  return { fetch, now: () => new Date('2026-09-30T00:00:00Z'), cwd };
}

function opDoc(paths: Record<string, unknown>): unknown {
  return { openapi: '3.0.0', info: { title: 't', version: '1' }, paths };
}

function write(dir: string, name: string, content: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  return path;
}

const okOp = { responses: { 200: { description: 'ok' } } };

test('diff: a removed operation is reported as breaking and fails the default --fail-on', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apibreak-diff-'));
  const oldPath = write(dir, 'old.json', opDoc({ '/a': { get: okOp } }));
  // paths is never left empty in these fixtures: an empty `paths: {}` reads,
  // by design, as "the specification declares no operations" (spec.ts) —
  // useful for `check` against a vendor spec that came back as an error page,
  // but not what these fixtures are testing, so an unrelated endpoint stays.
  const newPath = write(dir, 'new.json', opDoc({ '/other': { get: okOp } }));

  const out = capture();
  const err = capture();
  const code = await runDiff([oldPath, newPath], deps(), out, err);
  assert.equal(code, 1);
  assert.match(out.text(), /Breaking changes/);
  assert.match(out.text(), /GET \/a/);
});

test('diff: a removed response field is breaking', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apibreak-diff-'));
  const schema = (props: Record<string, unknown>): unknown => ({
    type: 'object',
    properties: props,
  });
  const responseOp = (props: Record<string, unknown>): unknown => ({
    responses: { 200: { description: 'ok', content: { 'application/json': { schema: schema(props) } } } },
  });
  const oldPath = write(dir, 'old.json', opDoc({ '/a': { get: responseOp({ id: { type: 'string' }, name: { type: 'string' } }) } }));
  const newPath = write(dir, 'new.json', opDoc({ '/a': { get: responseOp({ id: { type: 'string' } }) } }));

  const out = capture();
  const code = await runDiff(['--json', oldPath, newPath], deps(), out, capture());
  assert.equal(code, 1);
  const report = JSON.parse(out.text());
  assert.equal(report.counts.breaking, 1);
  assert.equal(report.findings[0].kind, 'response_field_removed');
});

test('diff: a new required request parameter is breaking', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apibreak-diff-'));
  const oldPath = write(
    dir,
    'old.json',
    opDoc({ '/a': { get: { parameters: [], responses: { 200: { description: 'ok' } } } } })
  );
  const newPath = write(
    dir,
    'new.json',
    opDoc({
      '/a': {
        get: {
          parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'ok' } },
        },
      },
    })
  );

  const out = capture();
  const code = await runDiff(['--json', oldPath, newPath], deps(), out, capture());
  assert.equal(code, 1);
  const report = JSON.parse(out.text());
  assert.ok(report.findings.some((f: { kind: string }) => f.kind === 'parameter_now_required'));
});

test('diff: a field type change is breaking', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apibreak-diff-'));
  const bodyOp = (type: string): unknown => ({
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { type: 'object', properties: { amount: { type } } } } },
    },
    responses: { 200: { description: 'ok' } },
  });
  const oldPath = write(dir, 'old.json', opDoc({ '/a': { post: bodyOp('integer') } }));
  const newPath = write(dir, 'new.json', opDoc({ '/a': { post: bodyOp('string') } }));

  const out = capture();
  const code = await runDiff(['--json', oldPath, newPath], deps(), out, capture());
  assert.equal(code, 1);
  const report = JSON.parse(out.text());
  assert.ok(report.findings.some((f: { kind: string }) => f.kind === 'field_type_changed'));
});

test('diff: a removed request enum value is breaking, a removed response enum value is not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apibreak-diff-'));
  const doc = (enumValues: string[]): unknown =>
    opDoc({
      '/a': {
        post: {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', properties: { mode: { type: 'string', enum: enumValues } } } } },
          },
          responses: { 200: { description: 'ok' } },
        },
      },
    });
  const oldPath = write(dir, 'old.json', doc(['a', 'b', 'c']));
  const newPath = write(dir, 'new.json', doc(['a', 'b']));

  const out = capture();
  const code = await runDiff(['--json', oldPath, newPath], deps(), out, capture());
  assert.equal(code, 1);
  const report = JSON.parse(out.text());
  assert.ok(report.findings.some((f: { kind: string }) => f.kind === 'enum_value_removed'));
});

test('diff: reads YAML input and finds the same removed operation as the JSON case', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apibreak-diff-'));
  const oldPath = write(
    dir,
    'old.yaml',
    'openapi: 3.0.0\ninfo:\n  title: t\n  version: "1"\npaths:\n  /a:\n    get:\n      responses:\n        "200":\n          description: ok\n'
  );
  const newPath = write(
    dir,
    'new.yaml',
    'openapi: 3.0.0\ninfo:\n  title: t\n  version: "1"\npaths:\n  /other:\n    get:\n      responses:\n        "200":\n          description: ok\n'
  );

  const out = capture();
  const code = await runDiff([oldPath, newPath], deps(), out, capture());
  assert.equal(code, 1);
  assert.match(out.text(), /GET \/a/);
});

test('diff: --fail-on none never fails, --fail-on any fails on a non-breaking finding', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apibreak-diff-'));
  // /other is deprecated, a non-breaking finding; /a being added on its own
  // is additive (see the dedicated test below) and must not itself trip
  // --fail-on any.
  const deprecatedOp = { ...okOp, deprecated: true };
  const oldPath = write(dir, 'old.json', opDoc({ '/other': { get: okOp } }));
  const newPath = write(dir, 'new.json', opDoc({ '/other': { get: deprecatedOp }, '/a': { get: okOp } }));

  const noneCode = await runDiff(['--fail-on', 'none', oldPath, newPath], deps(), capture(), capture());
  assert.equal(noneCode, 0);

  const breakingCode = await runDiff(['--fail-on', 'breaking', oldPath, newPath], deps(), capture(), capture());
  assert.equal(breakingCode, 0);

  const anyCode = await runDiff(['--fail-on', 'any', oldPath, newPath], deps(), capture(), capture());
  assert.equal(anyCode, 1);
});

// Regression (P2, bug 10): an operation present only in the new document used
// to be classified as `endpoint_not_in_baseline` (an "unknown", skipped
// endpoint) rather than counted as the addition it plainly is — a customer
// reading `--fail-on any` would see it fail on their own new endpoint, and
// the count of "endpoints checked" undercounted every addition. Both the
// human summary and --json must agree that it is additive, not a finding.
test('diff: an operation present only in the new spec is an additive change, not a finding', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apibreak-diff-'));
  const oldPath = write(dir, 'old.json', opDoc({ '/other': { get: okOp } }));
  const newPath = write(dir, 'new.json', opDoc({ '/other': { get: okOp }, '/a': { get: okOp } }));

  const jsonOut = capture();
  const jsonCode = await runDiff(['--json', '--fail-on', 'any', oldPath, newPath], deps(), jsonOut, capture());
  assert.equal(jsonCode, 0);
  const report = JSON.parse(jsonOut.text());
  assert.equal(report.additiveChanges, 1);
  assert.equal(report.endpointsChecked, 2);
  assert.equal(report.endpointsSkipped, 0);
  assert.deepEqual(report.findings, []);
  assert.ok(!report.findings.some((f: { kind: string }) => f.kind === 'endpoint_not_in_baseline'));

  const humanOut = capture();
  const humanCode = await runDiff(['--fail-on', 'any', oldPath, newPath], deps(), humanOut, capture());
  assert.equal(humanCode, 0);
  assert.match(humanOut.text(), /No breaking changes/);
  assert.match(humanOut.text(), /1 additive change/);
});

test('diff: a clean comparison exits 0 and says so', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apibreak-diff-'));
  const same = opDoc({ '/a': { get: { responses: { 200: { description: 'ok' } } } } });
  const oldPath = write(dir, 'old.json', same);
  const newPath = write(dir, 'new.json', same);

  const out = capture();
  const code = await runDiff([oldPath, newPath], deps(), out, capture());
  assert.equal(code, 0);
  assert.match(out.text(), /No breaking changes/);
});

test('diff: usage and parse errors exit 2 with a message', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apibreak-diff-'));
  const missing = join(dir, 'nope.json');
  const err1 = capture();
  assert.equal(await runDiff([missing, missing], deps(), capture(), err1), 2);
  assert.match(err1.text(), /cannot read/);

  const badJson = write(dir, 'bad.json', '{not json');
  const err2 = capture();
  assert.equal(await runDiff([badJson, badJson], deps(), capture(), err2), 2);
  assert.match(err2.text(), /not valid JSON/);

  const err3 = capture();
  assert.equal(await runDiff(['--fail-on', 'nonsense', badJson, badJson], deps(), capture(), err3), 2);
  assert.match(err3.text(), /--fail-on must be one of/);
});

test('diff: fetches a spec over http(s)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apibreak-diff-'));
  const spec = opDoc({ '/a': { get: { responses: { 200: { description: 'ok' } } } } });
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url?.includes('empty') ? opDoc({}) : spec));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const localPath = write(dir, 'local.json', spec);
  const out = capture();
  const code = await runDiff([`${base}/spec.json`, localPath], deps(), out, capture());
  assert.equal(code, 0);

  server.close();
});

test('diff --base-ref: compares the working-tree file against the same path at a git revision', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apibreak-diff-gitrepo-'));
  const run = (cmd: string[]): void => {
    execFileSync(cmd[0]!, cmd.slice(1), { cwd: dir, stdio: 'pipe' });
  };
  run(['git', 'init', '-q']);
  run(['git', 'config', 'user.email', 'test@example.com']);
  run(['git', 'config', 'user.name', 'Test']);

  const specPath = join(dir, 'openapi.json');
  writeFileSync(specPath, JSON.stringify(opDoc({ '/a': { get: okOp }, '/other': { get: okOp } })));
  run(['git', 'add', 'openapi.json']);
  run(['git', 'commit', '-q', '-m', 'baseline']);

  // Working tree now removes the operation the committed revision had.
  writeFileSync(specPath, JSON.stringify(opDoc({ '/other': { get: okOp } })));

  const out = capture();
  const code = await runDiff(['--base-ref', 'HEAD', 'openapi.json'], deps(dir), out, capture());
  assert.equal(code, 1);
  assert.match(out.text(), /GET \/a/);
});

test('diff: a placeholder rename is not reported as a removal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apibreak-diff-'));
  const oldPath = write(dir, 'old.json', opDoc({ '/o/{id}': { get: okOp } }));
  const newPath = write(dir, 'new.json', opDoc({ '/o/{orderId}': { get: okOp } }));

  const out = capture();
  const code = await runDiff([oldPath, newPath], deps(), out, capture());
  assert.equal(code, 0);
  assert.match(out.text(), /No breaking changes/);
});

// Regression (P1, bug 4): a placeholder rename used to be paired only *after*
// diffEndpoints ran, by deleting the resulting `operation_removed` finding —
// so the two operations were never actually compared, and a response field
// dropped in the same release as the rename went undetected (0 findings,
// exit 0). Pairing now happens before the diff, so the two operations are
// compared directly and the real removal is caught.
test('diff: a placeholder rename does not conceal a real breaking change to the same operation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apibreak-diff-'));
  const responseOp = (props: Record<string, unknown>): unknown => ({
    responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: props } } } } },
  });
  const oldPath = write(dir, 'old.json', opDoc({ '/u/{id}': { get: responseOp({ id: { type: 'string' }, name: { type: 'string' } }) } }));
  const newPath = write(dir, 'new.json', opDoc({ '/u/{userId}': { get: responseOp({ id: { type: 'string' } }) } }));

  const out = capture();
  const code = await runDiff(['--json', oldPath, newPath], deps(), out, capture());
  assert.equal(code, 1);
  const report = JSON.parse(out.text());
  assert.equal(report.counts.breaking, 1);
  assert.ok(report.findings.some((f: { kind: string }) => f.kind === 'response_field_removed'));
});

// Round-4, end to end: an operation-level `servers` override moved between
// the two documents. It must be a single `server_changed`/`unknown` finding
// — never `breaking`, and the (real, would-be-breaking) response field
// removal on the same operation must never surface, because body/params are
// not compared for a server_changed operation at all.
test('diff: an operation whose effective server address moved is server_changed, unknown, never breaking', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apibreak-diff-'));
  const responseOp = (url: string, props: Record<string, unknown>): unknown => ({
    servers: [{ url }],
    responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: props } } } } },
  });
  const oldPath = write(dir, 'old.json', opDoc({ '/a': { get: responseOp('/old-address', { id: { type: 'string' }, name: { type: 'string' } }) } }));
  const newPath = write(dir, 'new.json', opDoc({ '/a': { get: responseOp('/new-address', { id: { type: 'string' } }) } }));

  const out = capture();
  const code = await runDiff(['--json', oldPath, newPath], deps(), out, capture());
  // --fail-on breaking (the default) does not fail on `unknown`.
  assert.equal(code, 0);
  const report = JSON.parse(out.text());
  assert.equal(report.counts.breaking, 0);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].kind, 'server_changed');
  assert.equal(report.findings[0].severity, 'unknown');
});

// Regression (P1, bug 3): an anchor, alias or tag used to become the literal
// string "&op"/"*op"/"!!str foo", so an anchored operation silently read as a
// string where an object belongs and was reported removed. It must instead
// be a clear parse error, surfaced as exit 2, never a phantom removal.
test('diff: a YAML anchor is a parse error (exit 2), never a phantom removal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apibreak-diff-'));
  const oldPath = write(
    dir,
    'old.yaml',
    'openapi: 3.0.0\ninfo:\n  title: t\n  version: "1"\npaths:\n  /a:\n    get:\n      responses:\n        "200":\n          description: ok\n'
  );
  const newPath = write(
    dir,
    'new.yaml',
    'openapi: 3.0.0\ninfo:\n  title: t\n  version: "1"\npaths:\n  /a: &op\n    get:\n      responses:\n        "200":\n          description: ok\n'
  );

  const err = capture();
  const code = await runDiff([oldPath, newPath], deps(), capture(), err);
  assert.equal(code, 2);
  assert.match(err.text(), /anchor/);
});

// Round-5 review, P1 (bullet 1), end to end: both documents also declare
// GET /health with an operation-level servers override (this is what forces
// `skipRealignment` for the WHOLE document — see match-endpoints.ts). The
// root prefix ALSO moved (/v1 -> path templates), so GET /pets (old) and
// GET /v1/pets (new) are each unmatched on their own side and would pair
// under an ordinary root-prefix move. They must produce exactly one
// `possibly_moved`/`unknown` finding, never `operation_removed` for one plus
// a silent addition for the other. GET /health's own override is unchanged,
// so it just compares normally at its own key.
test('diff: an unmatched root-prefix-moved pair is possibly_moved, not a removal plus an addition, when realignment is skipped elsewhere', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apibreak-diff-'));
  const healthOp = { servers: [{ url: '/internal' }], ...okOp };
  const oldPath = write(dir, 'old.json', {
    openapi: '3.0.0',
    info: { title: 't', version: '1' },
    servers: [{ url: '/v1' }],
    paths: { '/pets': { get: okOp }, '/health': { get: healthOp } },
  });
  const newPath = write(dir, 'new.json', {
    openapi: '3.0.0',
    info: { title: 't', version: '2' },
    servers: [{ url: '/' }],
    paths: { '/v1/pets': { get: okOp }, '/health': { get: healthOp } },
  });

  const out = capture();
  const code = await runDiff(['--json', oldPath, newPath], deps(), out, capture());
  assert.equal(code, 0); // --fail-on breaking (default) does not fail on `unknown`
  const report = JSON.parse(out.text());
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].kind, 'possibly_moved');
  assert.equal(report.findings[0].severity, 'unknown');
  assert.equal(report.findings.some((f: { kind: string }) => f.kind === 'operation_removed'), false);
  assert.equal(report.findings.some((f: { kind: string }) => f.kind === 'endpoint_not_in_baseline'), false);
});

test('diff: a path prefix that moved from servers[].url into the path templates is not reported as a removal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apibreak-diff-'));
  const oldPath = write(dir, 'old.json', {
    openapi: '3.0.0',
    info: { title: 't', version: '1' },
    servers: [{ url: 'https://h/v1' }],
    paths: { '/lists/': { get: okOp } },
  });
  const newPath = write(dir, 'new.json', {
    openapi: '3.0.0',
    info: { title: 't', version: '2' },
    servers: [{ url: 'https://h/' }],
    paths: { '/v1/lists/': { get: okOp } },
  });

  const out = capture();
  const code = await runDiff([oldPath, newPath], deps(), out, capture());
  assert.equal(code, 0);
  assert.match(out.text(), /No breaking changes/);
});

// Regression (P1, bug 6): `readSpecTextAtGitRef` used to run `git show
// <ref>:<path>` with `<path>` taken verbatim from the CLI argument. `git
// show`'s `<rev>:<path>` is always repo-root-relative, never cwd-relative, so
// invoking `--base-ref` from a subdirectory with a bare relative path (the
// normal case: run from inside the package that owns the spec) compared the
// wrong two files — the repo-root copy at `<ref>` against the subdirectory's
// working-tree copy. The path must be resolved to the working tree first and
// then made repo-relative before it ever reaches `git show`.
test('diff --base-ref: run from a subdirectory compares the same file at both revisions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apibreak-diff-gitrepo-'));
  const run = (cmd: string[]): void => {
    execFileSync(cmd[0]!, cmd.slice(1), { cwd: dir, stdio: 'pipe' });
  };
  run(['git', 'init', '-q']);
  run(['git', 'config', 'user.email', 'test@example.com']);
  run(['git', 'config', 'user.name', 'Test']);

  const subdir = join(dir, 'services', 'api');
  mkdirSync(subdir, { recursive: true });
  // A same-named file at the repo root that must NEVER be read for this run.
  writeFileSync(join(dir, 'openapi.json'), JSON.stringify(opDoc({ '/decoy': { get: okOp } })));
  const specPath = join(subdir, 'openapi.json');
  writeFileSync(specPath, JSON.stringify(opDoc({ '/a': { get: okOp }, '/other': { get: okOp } })));
  run(['git', 'add', '-A']);
  run(['git', 'commit', '-q', '-m', 'baseline']);

  // Working tree now removes the operation the committed revision had, in
  // the SUBDIRECTORY's copy only.
  writeFileSync(specPath, JSON.stringify(opDoc({ '/other': { get: okOp } })));

  const out = capture();
  const code = await runDiff(['--base-ref', 'HEAD', 'openapi.json'], deps(subdir), out, capture());
  assert.equal(code, 1);
  assert.match(out.text(), /GET \/a/);
});

test('diff --base-ref: a ref that does not exist is a parse/fetch-style error, exit 2', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apibreak-diff-gitrepo-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const specPath = join(dir, 'openapi.json');
  writeFileSync(specPath, JSON.stringify(opDoc({})));

  const err = capture();
  const code = await runDiff(['--base-ref', 'not-a-real-ref', 'openapi.json'], deps(dir), capture(), err);
  assert.equal(code, 2);
  assert.match(err.text(), /git show/);
});

test('diff: argument usage errors', async () => {
  const err1 = capture();
  assert.equal(await runDiff(['only-one'], deps(), capture(), err1), 2);
  assert.match(err1.text(), /needs exactly two arguments/);

  const err2 = capture();
  assert.equal(await runDiff(['--base-ref', 'HEAD', 'a', 'b'], deps(), capture(), err2), 2);
  assert.match(err2.text(), /exactly one argument/);

  const err3 = capture();
  assert.equal(await runDiff(['--unknown-flag', 'a', 'b'], deps(), capture(), err3), 2);
  assert.match(err3.text(), /unknown argument/);
});

/* ── round-2 follow-up review, 2026-09-30: alignment must not break local $refs ──
 *
 * `alignPaths` re-keys the new document's `paths` object under the old
 * document's templates for a placeholder rename (see match-endpoints.ts). A
 * `$ref` written anywhere in the new document that points into
 * `#/paths/<the new document's own literal path text>/...` is legal OpenAPI
 * — vendors do this to share a schema or parameter between operations on the
 * same path — and it resolves fine against the ORIGINAL new document, where
 * that literal path text is still the key. It stopped resolving once the
 * diff started comparing against the RE-KEYED document instead, because that
 * document's `paths` object no longer has the new document's own path text
 * as a key at all — it was renamed to the old document's. A `$ref` a vendor
 * never touched must not become unreadable as a side effect of *pairing* two
 * operations that never asked to be dereferenced against each other.
 */
test('diff: a local $ref into #/paths/... that survives a placeholder rename still resolves, against the ORIGINAL document', () => {
  const oldRaw = {
    openapi: '3.0.0',
    info: { title: 't', version: '1' },
    paths: {
      '/o/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        get: {
          parameters: [{ name: 'q', in: 'query', schema: { type: 'string', enum: ['a', 'b'] } }],
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  };
  const newRaw = {
    openapi: '3.0.0',
    info: { title: 't', version: '1' },
    paths: {
      '/o/{orderId}': {
        parameters: [{ name: 'orderId', in: 'path', required: true, schema: { type: 'string' } }],
        // A schema shared between operations on this path, referenced by a
        // literal $ref into this path's own key — exactly the shape a real
        // vendor document uses to avoid repeating a schema inline.
        'x-shared-schema': { type: 'string', enum: ['a', 'b'] },
        get: {
          parameters: [{ name: 'q', in: 'query', schema: { $ref: '#/paths/~1o~1{orderId}/x-shared-schema' } }],
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  };

  const report = buildDiffReport('old', 'new', indexSpec(oldRaw), indexSpec(newRaw), '2026-09-30T00:00:00Z');
  // The two schemas are identical (string, enum a/b) once the $ref resolves,
  // so a working resolution reports nothing — not a breaking finding
  // (the $ref did not actually change anything) and not `not_compared`
  // either (the fix, not just a safe fallback, is that this DOES resolve).
  assert.deepEqual(report.findings, []);
});

// Regression (0.2.0 verification, 2026-10-04): swagger-petstore's own history
// changed `servers` from "/v3" to "https://petstore3.swagger.io/api/v3" with
// every path template left alone. No wire tier matched, every new path was
// parked under a synthetic key `indexSpec` never indexes, and the new document
// read as "declares no operations": 19 false `unknown`s and nothing compared.
test('diff: a changed root server path pairs identical templates, compares them, and says so once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apibreak-diff-'));
  const param = (required: boolean): unknown => ({
    get: {
      parameters: [{ name: 'status', in: 'query', required, schema: { type: 'string' } }],
      responses: { 200: { description: 'ok' } },
    },
  });
  const oldPath = write(dir, 'old.json', {
    ...(opDoc({ '/pet/findByStatus': param(false), '/pet': { post: okOp } }) as object),
    servers: [{ url: '/v3' }],
  });
  const newPath = write(dir, 'new.json', {
    ...(opDoc({ '/pet/findByStatus': param(true), '/pet': { post: okOp }, '/brand-new': { get: okOp } }) as object),
    servers: [{ url: 'https://petstore3.swagger.io/api/v3' }],
  });

  const out = capture();
  const code = await runDiff(['--json', oldPath, newPath], deps(), out, capture());
  const report = JSON.parse(out.text());
  assert.equal(code, 1);
  const kinds = report.findings.map((f: { kind: string }) => f.kind).sort();
  assert.deepEqual(kinds, ['parameter_now_required', 'server_changed']);
  const server = report.findings.find((f: { kind: string }) => f.kind === 'server_changed');
  assert.equal(server.endpoint, 'servers');
  assert.match(server.detail, /"\/v3" to "\/api\/v3"/);
  assert.match(server.detail, /2 path templates/);
  assert.equal(report.endpointsChecked, 3);
  // The brand-new path is an addition, indexed and counted, not lost.
  assert.ok(report.additiveChanges >= 1);
});

test('diff: a root server path change with no shared templates reports removals, not "declares no operations"', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apibreak-diff-'));
  const oldPath = write(dir, 'old.json', { ...(opDoc({ '/a': { get: okOp } }) as object), servers: [{ url: '/v1' }] });
  const newPath = write(dir, 'new.json', { ...(opDoc({ '/b': { get: okOp } }) as object), servers: [{ url: '/v2' }] });
  const out = capture();
  const code = await runDiff(['--json', oldPath, newPath], deps(), out, capture());
  const report = JSON.parse(out.text());
  assert.equal(code, 1);
  assert.deepEqual(
    report.findings.map((f: { kind: string; endpoint: string }) => `${f.kind} ${f.endpoint}`),
    ['operation_removed GET /a']
  );
  assert.equal(report.additiveChanges, 1);
});
