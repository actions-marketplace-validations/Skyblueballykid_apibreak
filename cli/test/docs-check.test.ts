/**
 * The judging half of `apibreak docs`: one test per finding type, then the
 * false-positive guards, then the CLI end to end on radar/fixtures/docs-check.
 */

import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseUrlBases, checkReferences, objectProps, resolveUrl, type DocsFinding } from '../src/docs-check.js';
import { docsExitCode, parseDocsArgs, runDocs, type DocsReport } from '../src/docs-cli.js';
import { scanMarkdown } from '../src/docs-extract.js';
import { expandBraces, expandGlobs, globToRegExp } from '../src/glob.js';
import { docFromText } from '../src/load-spec.js';
import { closestTemplate, hostMatcher, matchDocPath, operationServerBases, serverBases } from '../src/match-endpoints.js';
import type { Json, SpecDoc } from '../src/spec.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'docs-check');

function specOf(raw: Json): SpecDoc {
  const r = docFromText('spec.json', JSON.stringify(raw));
  assert.ok(r.ok, JSON.stringify(r));
  return r.doc;
}

const API: Json = {
  openapi: '3.0.3',
  info: { title: 'T', version: '1' },
  servers: [{ url: 'https://api.t.test/v1' }],
  components: {
    securitySchemes: { key: { type: 'apiKey', in: 'query', name: 'api_key' } },
    schemas: {
      User: {
        type: 'object',
        required: ['id', 'email'],
        properties: {
          id: { type: 'string', readOnly: true },
          email: { type: 'string' },
          name: { type: 'string' },
          nickname: { type: 'string', deprecated: true },
        },
      },
    },
  },
  paths: {
    '/users': {
      get: {
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
          { name: 'old_filter', in: 'query', deprecated: true, schema: { type: 'string' } },
          { name: 'filter', in: 'query', style: 'deepObject', schema: { type: 'object', properties: { status: { type: 'string' } } } },
        ],
        responses: { 200: { description: 'ok' } },
      },
      post: {
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
        responses: { 201: { description: 'ok' } },
      },
    },
    '/users/me': { get: { responses: { 200: { description: 'ok' } } } },
    '/users/{user_id}': {
      get: { responses: { 200: { description: 'ok' } } },
      delete: { responses: { 204: { description: 'ok' } } },
      patch: {
        requestBody: {
          content: { 'application/json': { schema: { type: 'object', additionalProperties: true, properties: { name: { type: 'string' } } } } },
        },
        responses: { 200: { description: 'ok' } },
      },
    },
    '/users/{user_id}/avatar': {
      put: { deprecated: true, responses: { 200: { description: 'ok' } } },
    },
    '/search': {
      get: {
        parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'ok' } },
      },
    },
    '/payments': {
      post: {
        requestBody: {
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  { type: 'object', required: ['amount', 'card'], properties: { amount: { type: 'integer' }, card: { type: 'string' } } },
                  { type: 'object', required: ['amount', 'iban'], properties: { amount: { type: 'integer' }, iban: { type: 'string' } } },
                ],
              },
            },
          },
        },
        responses: { 200: { description: 'ok' } },
      },
    },
    '/ping': { post: { responses: { 200: { description: 'ok' } } } },
    '/report': {
      get: {
        parameters: [{ name: 'opts', in: 'query', schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } } }],
        responses: { 200: { description: 'ok' } },
      },
    },
  },
};

function run(markdown: string, raw: Json = API, baseUrls: string[] = []): ReturnType<typeof checkReferences> {
  const scan = scanMarkdown(markdown, 'doc.md');
  return checkReferences(scan.references, specOf(raw), { baseUrls });
}
const rules = (fs: DocsFinding[]): string[] => fs.map((f) => `${f.rule}@${f.line}`);
const curlBlock = (...cmds: string[]): string => ['```bash', ...cmds, '```'].join('\n');

// --------------------------------------------------------- finding types --

test('unknown-endpoint: a path no template fits, with the closest spec path as the hint', () => {
  const r = run('Call `GET /v1/user/{id}` to read one.');
  assert.deepEqual(rules(r.findings), ['unknown-endpoint@1']);
  const f = r.findings[0]!;
  assert.equal(f.severity, 'error');
  assert.equal(f.reference, 'GET /v1/user/{id}');
  assert.equal(f.path, '/user/{id}');
  assert.match(f.hint, /Closest spec path: `GET\|PATCH\|DELETE \/users\/\{user_id\}`/);
  assert.equal(f.file, 'doc.md');
  assert.match(f.snippet, /GET \/v1\/user/);
});

test('wrong-method: a path that exists, called with a method it does not have', () => {
  const r = run(curlBlock('curl -X PUT https://api.t.test/v1/users/u_1'));
  assert.deepEqual(rules(r.findings), ['wrong-method@2']);
  assert.match(r.findings[0]!.hint, /GET, PATCH, DELETE/);
});

test('unknown-body-field: a JSON key the request schema ($ref) does not list, with a did-you-mean', () => {
  const r = run(curlBlock(`curl https://api.t.test/v1/users -H 'Content-Type: application/json' -d '{"emial": "a@b", "email": "a@b"}'`));
  assert.deepEqual(rules(r.findings), ['unknown-body-field@2']);
  assert.match(r.findings[0]!.hint, /Did you mean `email`\?/);
  assert.equal(r.findings[0]!.operation, 'POST /users');
});

test('unknown-body-field: a body sent to an operation that declares none', () => {
  const r = run(curlBlock(`curl https://api.t.test/v1/ping --json '{"x": 1}'`));
  assert.deepEqual(rules(r.findings), ['unknown-body-field@2']);
  assert.match(r.findings[0]!.detail, /declares no request body/);
  assert.match(r.findings[0]!.hint, /Remove the body/);
});

test('unknown-body-field: body keys that are the operation\'s query parameters say so (listmonk GET /bounces)', () => {
  const r = run(curlBlock(`curl -X GET 'https://api.t.test/v1/users?api_key=k' --data '{"limit": 5}'`));
  assert.deepEqual(rules(r.findings), ['unknown-body-field@2']);
  assert.equal(r.findings[0]!.hint, 'The spec has `limit` as a query parameter of GET /users; send it in the query string.');
});

test('unknown-query-param: a query key that is not a parameter', () => {
  const r = run('`GET /v1/users?limit=10&page=2`');
  assert.deepEqual(rules(r.findings), ['unknown-query-param@1']);
  assert.match(r.findings[0]!.detail, /"page"/);
});

test('missing-required: a required body field and a required query parameter', () => {
  const body = run(curlBlock(`curl https://api.t.test/v1/users --json '{"name": "A"}'`));
  assert.deepEqual(rules(body.findings), ['missing-required@2']);
  assert.match(body.findings[0]!.detail, /"email"/);
  assert.doesNotMatch(body.findings[0]!.detail, /"id"/, 'readOnly id is never required in a request');
  const query = run('`GET /v1/search?limit=3`');
  assert.deepEqual(rules(query.findings).sort(), ['missing-required@1', 'unknown-query-param@1']);
});

test('deprecated-operation: a warning, not an error', () => {
  const r = run(curlBlock('curl -X PUT https://api.t.test/v1/users/u_1/avatar'));
  assert.deepEqual(rules(r.findings), ['deprecated-operation@2']);
  assert.equal(r.findings[0]!.severity, 'warning');
});

test('deprecated-field: a deprecated body field and a deprecated query parameter', () => {
  const body = run(curlBlock(`curl https://api.t.test/v1/users --json '{"email": "a", "nickname": "b"}'`));
  assert.deepEqual(rules(body.findings), ['deprecated-field@2']);
  assert.equal(body.findings[0]!.severity, 'warning');
  const query = run('`GET /v1/users?old_filter=x`');
  assert.deepEqual(rules(query.findings), ['deprecated-field@1']);
});

test('queriesNotRead: a query string with an unread variable is counted and skipped, never judged for a missing required parameter', () => {
  const r = run(curlBlock('curl "https://api.t.test/v1/search?{filters}"'));
  assert.deepEqual(r.findings, []);
  assert.equal(r.queriesNotRead, 1);
});

test('missing-required: a required query parameter is flagged even with no query string at all, for a complete (non-prose) example', () => {
  const r = run(curlBlock('curl https://api.t.test/v1/search'));
  assert.deepEqual(rules(r.findings), ['missing-required@2']);
});

test('guard: a required query parameter is not flagged for a bare prose METHOD /path mention with no query string', () => {
  const r = run('`GET /v1/search`');
  assert.deepEqual(r.findings, []);
});

test('exploded object query parameter: schema property names are valid query keys; the object parameter\'s own name is never required', () => {
  const raw = structuredClone(API) as Record<string, Json>;
  raw.paths['/report'].get.parameters[0].required = true;
  const r = run('`GET /v1/report?from=a&to=b`', raw);
  assert.deepEqual(r.findings, []);
});

test('checkBody: a JSON example is checked only against the JSON media type, not merged with a sibling XML schema', () => {
  const raw = structuredClone(API) as Record<string, Json>;
  raw.paths['/users'].post.requestBody.content['application/xml'] = {
    schema: { type: 'object', properties: { xmlOnly: { type: 'string' } } },
  };
  const r = run(curlBlock(`curl https://api.t.test/v1/users --json '{"email": "a@b", "xmlOnly": "x"}'`), raw);
  assert.deepEqual(rules(r.findings), ['unknown-body-field@2']);
  assert.match(r.findings[0]!.detail, /"xmlOnly"/);
});

test('server scoping: an operation-level servers override does not lend its host to a sibling operation that has none', () => {
  const raw: Json = {
    openapi: '3.0.0',
    info: { title: 't', version: '1' },
    servers: [{ url: 'https://api.t.test/v1' }],
    paths: {
      '/x': { get: { servers: [{ url: 'https://other.test' }], responses: { 200: { description: 'ok' } } } },
      '/y': { get: { responses: { 200: { description: 'ok' } } } },
    },
  };
  const served = run(curlBlock('curl https://other.test/x'), raw);
  assert.deepEqual(served.findings, []);
  const notServed = run(curlBlock('curl https://other.test/y'), raw);
  assert.deepEqual(rules(notServed.findings), ['unknown-endpoint@2']);
});

test('operationServerBases: own override wins; falls back to the path item, then the document root; Swagger 2 is always global', () => {
  const doc: Json = {
    openapi: '3.0.0',
    servers: [{ url: 'https://root.test/v1' }],
    paths: {
      '/a': {
        servers: [{ url: 'https://item.test' }],
        get: { servers: [{ url: 'https://op.test' }], responses: {} },
        post: { responses: {} },
      },
    },
  };
  const pathItem = doc.paths['/a'];
  const getOp = pathItem.get;
  const postOp = pathItem.post;
  assert.equal(operationServerBases(doc, pathItem, getOp)[0]!.hostLabel, 'op.test');
  assert.equal(operationServerBases(doc, pathItem, postOp)[0]!.hostLabel, 'item.test');
  assert.equal(operationServerBases(doc, { get: {} }, {})[0]!.hostLabel, 'root.test');
  const s2 = operationServerBases({ swagger: '2.0', host: 'api.s.test', basePath: '/v2' }, {}, {});
  assert.equal(s2[0]!.hostLabel, 'api.s.test');
});

test('matchDocPath: a doc segment that is wholly a placeholder does not fit a template segment mixing a placeholder with literal text', () => {
  assert.deepEqual(matchDocPath('/files/{id}', ['/files/{id}.json']), []);
});

// ------------------------------------------------- false-positive guards --

test('guard: other hosts are skipped and counted, not checked', () => {
  const r = run(curlBlock('curl https://api.github.com/repos/a/b', 'curl http://localhost:3000/nope'));
  assert.equal(r.findings.length, 0);
  assert.equal(r.checked, 0);
  assert.deepEqual(r.ignored.map((i) => i.host), ['api.github.com', 'localhost:3000']);
});

test('guard: --base-url makes a local or staging host count as the API, prefix and all', () => {
  const r = run(curlBlock('curl http://localhost:3000/api/users/me', 'curl http://localhost:3000/api/nope'), API, ['http://localhost:3000/api']);
  assert.equal(r.checked, 2);
  assert.deepEqual(rules(r.findings), ['unknown-endpoint@3']);
});

test('guard: concrete path values fit templates; a literal segment beats a placeholder', () => {
  const r = run(['`GET /v1/users/u_123`', '`DELETE /v1/users/42`', '`GET /v1/users/me`', '`GET /v1/users/:id`', '`GET /v1/users/<user-id>`', '`GET /v1/users/${id}`'].join('\n'));
  assert.deepEqual(r.findings, []);
  assert.equal(r.checked, 6);
  assert.deepEqual(matchDocPath('/users/me', ['/users/{user_id}', '/users/me']), ['/users/me']);
});

test('guard: trailing slashes, query strings, fragments and the server prefix do not break a match', () => {
  const r = run(['`GET /v1/users/`', '`GET /v1/users?limit=1#x`', '`GET /users/me`', 'GET https://api.t.test/v1/users/me/'].join('\n'));
  assert.deepEqual(r.findings, []);
});

test('guard: additionalProperties true means any body field is fine', () => {
  const r = run(curlBlock(`curl -X PATCH https://api.t.test/v1/users/u_1 --json '{"anything": 1, "name": "x"}'`));
  assert.deepEqual(r.findings, []);
});

test('guard: oneOf is a union of fields and an intersection of required', () => {
  const card = run(curlBlock(`curl https://api.t.test/v1/payments --json '{"amount": 1, "card": "x"}'`));
  assert.deepEqual(card.findings, []);
  const iban = run(curlBlock(`curl https://api.t.test/v1/payments --json '{"amount": 1, "iban": "x"}'`));
  assert.deepEqual(iban.findings, []);
  const none = run(curlBlock(`curl https://api.t.test/v1/payments --json '{"card": "x"}'`));
  assert.deepEqual(rules(none.findings), ['missing-required@2']);
  assert.match(none.findings[0]!.detail, /"amount"/);
});

test('guard: an apiKey query parameter, a deepObject key and an exploded object parameter are known', () => {
  const r = run(['`GET /v1/users?api_key=k&filter[status]=on`', '`GET /v1/report?from=a&to=b`'].join('\n'));
  assert.deepEqual(r.findings, []);
});

test('guard: a body that could not be read is counted and never judged', () => {
  const r = run(curlBlock('curl https://api.t.test/v1/users -d @user.json'));
  assert.deepEqual(r.findings, []);
  assert.equal(r.bodiesNotRead, 1);
});

test('guard: an incomplete body (spread, ellipsis) is not missing anything', () => {
  const r = run(['```js', "fetch('https://api.t.test/v1/users', { method: 'POST', body: JSON.stringify({ ...base, name: 'x' }) })", '```'].join('\n'));
  assert.deepEqual(r.findings, []);
});

test('guard: unparsable blocks yield nothing to check', () => {
  const scan = scanMarkdown(['```bash', 'curl -X "$M" https://api.t.test/v1/users', 'curl https://a.test/x https://b.test/y', '```'].join('\n'), 'doc.md');
  assert.equal(scan.references.length, 0);
  assert.equal(scan.unparsed.length, 2);
  assert.deepEqual(checkReferences(scan.references, specOf(API)).findings, []);
});

test('guard: a URL that is only a variable is unresolved, not an unknown endpoint', () => {
  const r = run(curlBlock('curl $API_URL'));
  assert.deepEqual(r.findings, []);
  assert.equal(r.unresolved.length, 1);
});

test('guard: an unresolvable $ref switches body checks off', () => {
  const raw = structuredClone(API) as Record<string, Json>;
  raw.paths['/users'].post.requestBody.content['application/json'].schema = { $ref: '#/components/schemas/Missing' };
  const r = run(curlBlock(`curl https://api.t.test/v1/users --json '{"x": 1}'`), raw);
  assert.deepEqual(r.findings, []);
});

test('guard: two equally good templates skip field checks rather than guess', () => {
  const raw: Json = {
    openapi: '3.0.0',
    info: { title: 'x', version: '1' },
    paths: {
      '/a/{x}': { post: { requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { p: {} } } } } }, responses: {} } },
      '/{y}/b': { post: { requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { q: {} } } } } }, responses: {} } },
    },
  };
  const r = run(curlBlock(`curl -X POST /a/b --json '{"z": 1}'`), raw);
  assert.deepEqual(r.findings, []);
  assert.equal(r.checked, 1);
});

test('guard: Swagger 2.0 formData parameters are the body', () => {
  const raw: Json = {
    swagger: '2.0',
    info: { title: 'x', version: '1' },
    host: 'api.s.test',
    basePath: '/v2',
    paths: {
      '/pet/{id}': {
        post: {
          consumes: ['application/x-www-form-urlencoded'],
          parameters: [
            { name: 'id', in: 'path', required: true, type: 'integer' },
            { name: 'name', in: 'formData', type: 'string' },
            { name: 'status', in: 'formData', required: true, type: 'string' },
          ],
          responses: { 200: { description: 'ok' } },
        },
      },
    },
  };
  assert.deepEqual(run(curlBlock('curl https://api.s.test/v2/pet/1 -d name=x -d status=y'), raw).findings, []);
  assert.deepEqual(rules(run(curlBlock('curl https://api.s.test/v2/pet/1 -d nme=x'), raw).findings).sort(), ['missing-required@2', 'unknown-body-field@2']);
});

// --------------------------------------------------------------- helpers --

test('objectProps: allOf merges; no declared properties is open; readOnly never required', () => {
  const doc: Json = {};
  const all = objectProps({ allOf: [{ properties: { a: {} }, required: ['a'] }, { properties: { b: { readOnly: true } }, required: ['b'] }] }, doc);
  assert.deepEqual([...all.props.keys()], ['a', 'b']);
  assert.deepEqual([...all.required], ['a']);
  assert.equal(all.open, false);
  assert.equal(objectProps({ type: 'object' }, doc).open, true);
  assert.equal(objectProps({ type: 'array', items: {} }, doc).open, true);
  assert.equal(objectProps({ properties: { a: {} }, additionalProperties: { type: 'string' } }, doc).open, true);
  assert.equal(objectProps({ properties: { a: {} }, additionalProperties: false }, doc).open, false);
});

test('resolveUrl: known host, other host, variable base, bare path, prefix candidates', () => {
  const bases = serverBases({ servers: [{ url: 'https://api.t.test/v1' }] });
  assert.deepEqual(resolveUrl('https://api.t.test/v1/a?x=1', bases), { kind: 'path', candidates: ['/a', '/v1/a'] });
  assert.deepEqual(resolveUrl('https://evil.test/v1/a', bases), { kind: 'other-host', host: 'evil.test' });
  assert.deepEqual(resolveUrl('{{baseUrl}}/v1/a', bases), { kind: 'path', candidates: ['/a', '/v1/a'], variableHost: '{{baseUrl}}' });
  assert.deepEqual(resolveUrl('YOUR_API_URL/a', bases), { kind: 'path', candidates: ['/a'], variableHost: 'YOUR_API_URL' });
  assert.equal(resolveUrl('a/b', bases).kind, 'unresolved');
  assert.deepEqual(resolveUrl('/v1/%7Bid%7D', bases), { kind: 'path', candidates: ['/{id}', '/v1/{id}'] });
});

test('guard: a <placeholder> in a curl URL is a path value, and options after it still count (Clerk revoke-invitation)', () => {
  const raw: Json = {
    openapi: '3.0.3',
    info: { title: 'T', version: '1' },
    servers: [{ url: 'https://api.t.test/v1' }],
    paths: { '/invitations/{invitation_id}/revoke': { post: { responses: { 200: { description: 'ok' } } } } },
  };
  const r = run(curlBlock('curl https://api.t.test/v1/invitations/<invitation_id>/revoke -X POST -H "Authorization: Bearer <SECRET_KEY>"'), raw);
  assert.deepEqual(r.findings, []);
  assert.equal(r.checked, 1);
  // A placeholder in the host is the reader's own deployment, never "no path matches /".
  const host = run(curlBlock('curl https://<database_name>-<org>.turso.io/v1/invitations/i_1/revoke -X POST'), raw);
  assert.deepEqual(host.findings, []);
});

test('guard: a placeholder host is this API only when the path says so; otherwise it is skipped as another host', () => {
  // The reader's own app behind a placeholder host (Upstash, Fly, ngrok guides): skipped, counted.
  const app = run(curlBlock('curl -X POST https://<YOUR-PRODUCTION-URL>/api/workflow', 'curl -X POST <DEPLOYMENT_URL>/workflow'));
  assert.deepEqual(app.findings, []);
  assert.equal(app.checked, 0);
  assert.deepEqual(app.ignored.map((i) => i.host), ['<your-production-url>', '<DEPLOYMENT_URL>']);
  // A path that fits the spec, or that starts with the server prefix, is still this API and still judged.
  const fits = run(curlBlock('curl -X PUT https://<your-host>/users/u_1', 'curl https://<your-host>/v1/userz'));
  assert.deepEqual(fits.findings.map((f) => f.rule), ['wrong-method', 'unknown-endpoint']);
});

test('guard: a URL passed as the last path segment stays one value (QStash /v2/publish/{destination})', () => {
  const raw: Json = {
    openapi: '3.0.3',
    info: { title: 'T', version: '1' },
    servers: [{ url: 'https://qstash.t.test' }],
    paths: { '/v2/publish/{destination}': { post: { responses: { 200: { description: 'ok' } } } } },
  };
  assert.deepEqual(resolveUrl('https://qstash.t.test/v2/publish/https://example.com/hook', serverBases(raw)), {
    kind: 'path',
    candidates: ['/v2/publish/https%3A%2F%2Fexample.com%2Fhook'],
  });
  const r = run(curlBlock('curl -X POST https://qstash.t.test/v2/publish/https://example.com/hook -d "{}"'), raw);
  assert.deepEqual(r.findings, []);
});

test('guard: a curl command quoted in an inline code span ends at the closing backtick (Typesense health)', () => {
  const r = run(['```', '- `curl https://api.t.test/v1/users` - list users', '```'].join('\n'));
  assert.deepEqual(r.findings, []);
  assert.equal(r.checked, 1);
});

test('guard: a paired backtick substitution is opaque text, not the end of the command', () => {
  const r = run(curlBlock('curl https://api.t.test/v1/users -H X-Token:`cat token.txt` -X POST -d \'{"email": "a@b.c"}\''));
  assert.deepEqual(rules(r.findings), []);
  assert.equal(r.checked, 1);
  // A substitution in the URL is an unknown value, never literal segments (`cat /tmp/id` is not /tmp/id).
  const sub = run(curlBlock('curl https://api.t.test/v1/users/`cat /tmp/id`'));
  assert.deepEqual(rules(sub.findings), []);
  // A command opened by a backtick ends at the first unescaped one.
  const nested = run(curlBlock('echo `curl https://api.t.test/v1/users -H X-Token:\\`printf token\\` -X POST -d \'{"email": "a@b.c"}\'`'));
  assert.deepEqual(rules(nested.findings), []);
  assert.equal(nested.checked, 1);
  // Two inline commands on one line are two references, each ending at its own closing backtick.
  const two = run(['```', '- `curl https://api.t.test/v1/users` and `curl https://api.t.test/v1/users/me`', '```'].join('\n'));
  assert.deepEqual(two.findings, []);
  assert.equal(two.checked, 2);
});

test('guard: a placeholder host the spec\'s own templated server matches is this API, and still judged', () => {
  const raw: Json = {
    openapi: '3.0.3',
    info: { title: 'T', version: '1' },
    servers: [{ url: 'https://{tenant}.example.com', variables: { tenant: { default: 'acme' } } }],
    paths: { '/users': { get: { responses: { 200: { description: 'ok' } } } } },
  };
  const r = run(curlBlock('curl https://{tenant}.example.com/removed'), raw);
  assert.deepEqual(rules(r.findings), ['unknown-endpoint@2']);
  assert.equal(r.ignored.length, 0);
});

test('guard: PowerShell backticks are escapes, a double-backtick span closes on its own run, quoted substitutions are unknown values', () => {
  const ps = run(['```powershell', 'curl.exe https://api.t.test/v1/users?limit=1`&offset=2 -X POST -d "{}"', '```'].join('\n'));
  assert.ok(!rules(ps.findings).some((r) => r.startsWith('wrong-method')), JSON.stringify(ps.findings));
  const span = run(['```text', "- ``curl https://api.t.test/v1/users -H 'X-Note: a`b' -X POST -d '{\"email\": \"a@b.c\"}'``", '```'].join('\n'));
  assert.deepEqual(rules(span.findings), []);
  assert.equal(span.checked, 1);
  const quoted = run(curlBlock('curl "https://api.t.test/v1/users/`cat /tmp/id`"'));
  assert.deepEqual(rules(quoted.findings), []);
  // A path built by a substitution is unresolved, never judged by its assumed shape.
  const built = run(curlBlock('curl https://api.t.test/v1/`printf users/me`'));
  assert.deepEqual(rules(built.findings), []);
  assert.equal(built.unresolved.length, 1);
  // A PowerShell escaped quote inside a double-quoted string does not end it.
  const psq = run(['```powershell', 'curl.exe https://api.t.test/v1/users -H "X-Note: a`";b" -X POST -d "{}"', '```'].join('\n'));
  assert.ok(!rules(psq.findings).some((r) => r.startsWith('wrong-method')), JSON.stringify(psq.findings));
});

test('guard: a URL embedded as the very first path segment is one value too', () => {
  const raw: Json = {
    openapi: '3.0.3',
    info: { title: 'T', version: '1' },
    servers: [{ url: 'https://api.t.test' }],
    paths: { '/{destination}': { post: { responses: { 200: { description: 'ok' } } } } },
  };
  assert.deepEqual(rules(run(curlBlock('curl -X POST https://api.t.test/https://example.com/hook'), raw).findings), []);
});

test('serverBases: Swagger 2 host+basePath, server variables, path-level servers, no servers', () => {
  const s2 = serverBases({ swagger: '2.0', host: 'api.x.test', basePath: '/v2' });
  assert.equal(s2.length, 1);
  assert.equal(s2[0]!.prefix, '/v2');
  assert.ok(s2[0]!.host!.test('api.x.test'));
  const vars = serverBases({ servers: [{ url: 'https://{region}.x.test/{version}', variables: { region: { default: 'eu' }, version: { default: 'v3' } } }] });
  assert.ok(vars.some((b) => b.host?.test('us.x.test')));
  const pathLevel = serverBases({ servers: [{ url: '/api' }], paths: { '/a': { servers: [{ url: 'https://files.x.test/up' }] } } });
  assert.deepEqual(pathLevel.map((b) => b.prefix).sort(), ['/api', '/up']);
  assert.deepEqual(serverBases({ openapi: '3.0.0' }), [{ host: null, hostLabel: null, prefix: '' }]);
});

test('hostMatcher: no port written matches any port; a written port must match', () => {
  assert.ok(hostMatcher('localhost').test('localhost:8080'));
  assert.ok(!hostMatcher('localhost:3000').test('localhost:8080'));
});

test('baseUrlBases: a URL and a bare prefix', () => {
  const [a, b] = baseUrlBases(['https://staging.t.test/api/', '/internal']);
  assert.equal(a!.prefix, '/api');
  assert.ok(a!.host!.test('staging.t.test:8443'));
  assert.deepEqual(b, { host: null, hostLabel: null, prefix: '/internal' });
});

test('matchDocPath: segment counts must agree; placeholders fit anything; mixed segments fit by shape', () => {
  assert.deepEqual(matchDocPath('/a/b/c', ['/a/{x}']), []);
  assert.deepEqual(matchDocPath('/files/{name}.json', ['/files/{file}.{ext}']), ['/files/{file}.{ext}']);
  assert.deepEqual(matchDocPath('/{{org}}/repos', ['/{owner}/repos']), ['/{owner}/repos']);
});

test('closestTemplate: the nearest by name, nothing when nothing is near', () => {
  assert.equal(closestTemplate('/costumers/{id}', ['/customers/{customer_id}', '/charges']), '/customers/{customer_id}');
  assert.equal(closestTemplate('/zzzzzzzz/qqqq/rrrr', ['/a']), undefined);
});

test('glob: braces, ** and *, directories, unmatched patterns reported', async () => {
  assert.deepEqual(expandBraces('d/*.{md,mdx}'), ['d/*.md', 'd/*.mdx']);
  assert.ok(globToRegExp('docs/**/*.md').test('docs/a.md'));
  assert.ok(globToRegExp('docs/**/*.md').test('docs/x/y/a.md'));
  assert.ok(!globToRegExp('docs/*.md').test('docs/x/a.md'));
  const dir = mkdtempSync(join(tmpdir(), 'apibreak-glob-'));
  mkdirSync(join(dir, 'docs', 'sub'), { recursive: true });
  mkdirSync(join(dir, 'node_modules', 'p'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'a.md'), '');
  writeFileSync(join(dir, 'docs', 'sub', 'b.mdx'), '');
  writeFileSync(join(dir, 'docs', 'sub', 'c.txt'), '');
  writeFileSync(join(dir, 'node_modules', 'p', 'README.md'), '');
  assert.deepEqual(await expandGlobs(['docs/**/*.{md,mdx}', 'nope/*.md'], dir), { files: ['docs/a.md', 'docs/sub/b.mdx'], unmatched: ['nope/*.md'] });
  assert.deepEqual((await expandGlobs(['docs'], dir)).files, ['docs/a.md', 'docs/sub/b.mdx']);
  assert.deepEqual((await expandGlobs(['**/*.md'], dir)).files, ['docs/a.md']);
});

// ---------------------------------------------------------------- the CLI --

test('parseDocsArgs: --spec required, repeated --base-url, --fail-on validated, --x=v form', () => {
  assert.deepEqual(parseDocsArgs([]), { error: '--spec is required' });
  const o = parseDocsArgs(['--spec=a.yaml', '--base-url', 'http://l:1/api', '--base-url=/x', '--fail-on', 'warning', 'docs/*.md']);
  assert.ok(!('error' in o));
  assert.deepEqual(o.baseUrls, ['http://l:1/api', '/x']);
  assert.equal(o.failOn, 'warning');
  assert.deepEqual(o.patterns, ['docs/*.md']);
  assert.ok('error' in parseDocsArgs(['--spec', 'a', '--fail-on', 'sometimes']));
});

const sink = (): { write: (s: string) => void; text: () => string } => {
  let buf = '';
  return { write: (s) => void (buf += s), text: () => buf };
};
const deps = (cwd: string) => ({
  cwd,
  now: () => new Date('2026-10-04T00:00:00Z'),
  fetch: (() => Promise.reject(new Error('no network in tests'))) as unknown as typeof fetch,
});

test('end to end: the fixture docs folder against its spec', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'apibreak-docs-'));
  const out = sink();
  const err = sink();
  const json = join(outDir, 'report.json');
  const summary = join(outDir, 'summary.md');
  const code = await runDocs(['--spec', 'openapi.yaml', '--json', json, '--summary', summary], deps(FIXTURE), out, err);
  assert.equal(err.text(), '');
  assert.equal(code, 1, 'errors fail the run by default');

  const report = JSON.parse(readFileSync(json, 'utf8')) as DocsReport;
  assert.deepEqual(report.counts, {
    filesScanned: 3,
    references: 21,
    parsed: 19,
    unparsed: 2,
    checked: 17,
    ignoredOtherHost: 2,
    suppressed: 2,
    bodiesNotRead: 1,
    queriesNotRead: 0,
    errors: 7,
    warnings: 2,
  });
  assert.equal(report.specTitle, 'Acme API');
  assert.deepEqual(
    report.findings.map((f) => `${f.file}:${f.line} ${f.rule}`),
    [
      'docs/quickstart.md:18 unknown-body-field',
      'docs/quickstart.md:18 missing-required',
      'docs/quickstart.md:22 unknown-endpoint',
      'docs/quickstart.md:24 wrong-method',
      'docs/quickstart.md:27 deprecated-field',
      'docs/quickstart.md:36 unknown-query-param',
      'docs/quickstart.md:40 unknown-query-param',
      'docs/quickstart.md:40 missing-required',
      'docs/quickstart.md:44 deprecated-operation',
    ]
  );
  assert.deepEqual(report.ignoredHosts.map((h) => h.host).sort(), ['api.github.com', 'localhost:3000']);
  assert.ok(report.unparsed.every((u) => u.file === 'docs/guides/advanced.mdx'));

  const md = readFileSync(summary, 'utf8');
  assert.equal(out.text(), `${md}\n`, '--summary holds exactly what was printed');
  assert.match(md, /docs\/quickstart\.md:22/);
  assert.match(md, /Did you mean `email`\?/);
});

test('end to end: --fail-on warning and never; exit codes for a clean run', async () => {
  const fixture = (failOn: string) => runDocs(['--spec', 'openapi.yaml', '--fail-on', failOn], deps(FIXTURE), sink(), sink());
  assert.equal(await fixture('never'), 0);
  assert.equal(await fixture('warning'), 1);

  const dir = mkdtempSync(join(tmpdir(), 'apibreak-docs-clean-'));
  writeFileSync(join(dir, 'openapi.yaml'), readFileSync(join(FIXTURE, 'openapi.yaml')));
  writeFileSync(join(dir, 'README.md'), '```bash\ncurl https://api.acme.test/v1/customers/cus_1\n```\n');
  assert.equal(await runDocs(['--spec', 'openapi.yaml'], deps(dir), sink(), sink()), 0);

  const warningOnly = { severity: 'warning' } as DocsFinding;
  const report = { counts: { errors: 0, warnings: 1 }, findings: [warningOnly] } as unknown as DocsReport;
  assert.equal(docsExitCode(report, 'error'), 0);
  assert.equal(docsExitCode(report, 'warning'), 1);
});

test('end to end: usage errors, an unreadable spec and zero files exit 2', async () => {
  const err = sink();
  assert.equal(await runDocs([], deps(FIXTURE), sink(), err), 2);
  assert.match(err.text(), /--spec is required/);
  assert.equal(await runDocs(['--spec', 'missing.yaml'], deps(FIXTURE), sink(), sink()), 2);
  const empty = mkdtempSync(join(tmpdir(), 'apibreak-docs-empty-'));
  writeFileSync(join(empty, 'openapi.yaml'), readFileSync(join(FIXTURE, 'openapi.yaml')));
  assert.equal(await runDocs(['--spec', 'openapi.yaml'], deps(empty), sink(), sink()), 2);
  const err2 = sink();
  assert.equal(await runDocs(['--spec', 'openapi.yaml', 'nothing/*.md'], deps(empty), sink(), err2), 2);
  assert.match(err2.text(), /nothing\/\*\.md matched no files/);
});

test('end to end: a --json or --summary path whose directory does not exist is a usage error (exit 2), not a swallowed finding', async () => {
  const bad = join(FIXTURE, 'nope', 'report.json');
  const err1 = sink();
  assert.equal(await runDocs(['--spec', 'openapi.yaml', '--json', bad], deps(FIXTURE), sink(), err1), 2);
  assert.match(err1.text(), /cannot write/);
  const err2 = sink();
  assert.equal(await runDocs(['--spec', 'openapi.yaml', '--summary', bad], deps(FIXTURE), sink(), err2), 2);
  assert.match(err2.text(), /cannot write/);
});
