/**
 * The extraction half of `apibreak docs`: one group per extractor, plus the
 * Markdown splitter. Every "unparsed" case here is a promise that the check
 * skips and counts a call it cannot read, rather than guessing at it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCurl,
  parseFetchArgs,
  parseHttpRequest,
  parsePythonArgs,
  proseReferences,
  queryKeysOf,
  queryOf,
  scanMarkdown,
  shellWords,
  splitMarkdown,
} from '../src/docs-extract.js';

const curl = (cmd: string): ReturnType<typeof parseCurl> => {
  const { words, heredoc } = shellWords(cmd);
  return parseCurl(words, heredoc);
};
const ok = <T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> => {
  assert.equal(r.ok, true, JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
};
const md = (...lines: string[]): string => lines.join('\n');

// ------------------------------------------------------------------ shell --

test('shellWords: quotes, ANSI-C quotes, escapes and adjacent pieces join as a shell would', () => {
  assert.deepEqual(shellWords(`curl -d '{"a": "'"$X"'"}' "https://h/x" a\\ b $'c\\nd'`).words, [
    'curl',
    '-d',
    '{"a": "$X"}',
    'https://h/x',
    'a b',
    'c\nd',
  ]);
});

test('shellWords: stops at a pipe, a redirect, && and a comment; flags a here-document', () => {
  assert.deepEqual(shellWords('curl https://h/x | jq .').words, ['curl', 'https://h/x']);
  assert.deepEqual(shellWords('curl https://h/x > out.json').words, ['curl', 'https://h/x']);
  assert.deepEqual(shellWords('curl https://h/x && echo ok').words, ['curl', 'https://h/x']);
  assert.deepEqual(shellWords('curl https://h/x # list').words, ['curl', 'https://h/x']);
  assert.deepEqual(shellWords('curl https://h/x` - check health').words, ['curl', 'https://h/x']);
  assert.deepEqual(shellWords('curl https://h/x -H T:`cat t` -X POST').words, ['curl', 'https://h/x', '-H', 'T:{cmd}', '-X', 'POST']);
  // An escaped backtick inside a substitution does not close it.
  assert.deepEqual(shellWords('curl https://h/x -H T:`printf \\`printf t\\`` -X POST').words, ['curl', 'https://h/x', '-H', 'T:{cmd}', '-X', 'POST']);
  // `<name>` is a placeholder, not a redirect; `< file` and `<<EOF` still are what they look like.
  assert.deepEqual(shellWords('curl https://h/a/<ID>/b -X POST').words, ['curl', 'https://h/a/<ID>/b', '-X', 'POST']);
  assert.deepEqual(shellWords('curl https://h/x > out.json <in').words, ['curl', 'https://h/x']);
  assert.equal(shellWords('curl -d @- https://h/x <<EOF').heredoc, true);
});

// ------------------------------------------------------------------- curl --

test('curl: GET by default, the URL and its query keys', () => {
  const r = ok(curl('curl "https://api.x.test/v1/items?limit=10&expand[]=owner"'));
  assert.equal(r.ref.method, 'GET');
  assert.equal(r.ref.url, 'https://api.x.test/v1/items?limit=10&expand[]=owner');
  assert.deepEqual(r.ref.query, ['limit', 'expand[]']);
  assert.equal(r.ref.body, null);
});

test('curl: -X/--request/-XPOST/--request=PATCH set the method', () => {
  assert.equal(ok(curl('curl -X DELETE https://h/x')).ref.method, 'DELETE');
  assert.equal(ok(curl('curl --request put https://h/x')).ref.method, 'PUT');
  assert.equal(ok(curl('curl -XPOST https://h/x')).ref.method, 'POST');
  assert.equal(ok(curl('curl --request=PATCH https://h/x')).ref.method, 'PATCH');
  assert.equal(ok(curl('curl -I https://h/x')).ref.method, 'HEAD');
});

test('curl: data implies POST; a JSON body gives its top-level keys', () => {
  const r = ok(curl(`curl https://h/v1/c -H 'Content-Type: application/json' -d '{"email":"a@b","address":{"city":"x"}}'`));
  assert.equal(r.ref.method, 'POST');
  assert.deepEqual(r.ref.body, { encoding: 'json', keys: ['email', 'address'], complete: true });
});

test('curl: --json is a JSON body and a POST', () => {
  const r = ok(curl(`curl --json '{"a":1}' https://h/x`));
  assert.equal(r.ref.method, 'POST');
  assert.deepEqual(r.ref.body?.keys, ['a']);
});

test('curl: repeated -d key=value is form data, with bracketed keys kept for the checker', () => {
  const r = ok(curl('curl https://h/v1/charges -u sk_test: -d amount=2000 -d currency=usd -d "metadata[order_id]"=6735'));
  assert.deepEqual(r.ref.body, { encoding: 'form', keys: ['amount', 'currency', 'metadata[order_id]'], complete: true });
});

test('curl: -G moves data to the query string; --data-urlencode names its key', () => {
  const r = ok(curl('curl -G https://h/search --data-urlencode "q=a b" -d limit=3'));
  assert.equal(r.ref.method, 'GET');
  assert.equal(r.ref.body, null);
  assert.deepEqual(r.ref.query, ['q', 'limit']);
});

test('curl: -F is multipart with its field names', () => {
  const r = ok(curl('curl -F purpose=avatar -F file=@me.png https://h/files'));
  assert.deepEqual(r.ref.body, { encoding: 'multipart', keys: ['purpose', 'file'], complete: true });
});

test('curl: a body read from a file, a here-document or invalid JSON is kept but unread', () => {
  const fromFile = ok(curl('curl -X POST https://h/x -d @body.json'));
  assert.equal(fromFile.ref.body?.keys, null);
  assert.match(fromFile.ref.body?.unread ?? '', /file/);
  const heredoc = ok(curl(`curl -X POST https://h/x -H 'Content-Type: application/json' -d @- <<EOF`));
  assert.equal(heredoc.ref.body?.keys, null);
  const ellipsis = ok(curl(`curl https://h/x -d '{"a": 1, ...}'`));
  assert.equal(ellipsis.ref.body?.keys, null);
  assert.equal(ellipsis.ref.body?.complete, false);
});

test('curl: options that take values never become the URL', () => {
  const r = ok(curl('curl -sS -o /tmp/out -w "%{http_code}" -H "Authorization: Bearer $T" --max-time 5 https://h/x'));
  assert.equal(r.ref.url, 'https://h/x');
});

test('curl: unparsed when no URL, two URLs, or a computed method', () => {
  assert.equal(curl('curl -X POST').ok, false);
  const two = curl('curl https://h/a https://h/b');
  assert.equal(two.ok, false);
  assert.match((two as { reason: string }).reason, /more than one/);
  assert.equal(curl('curl -X $METHOD https://h/a').ok, false);
});

test('curl: -T/--upload-file implies PUT (unless -X overrides) and an unread body', () => {
  const r = ok(curl('curl -T ./report.json https://h/v1/files/report'));
  assert.equal(r.ref.method, 'PUT');
  assert.equal(r.ref.body?.keys, null);
  assert.match(r.ref.body?.unread ?? '', /uploaded from a file/);
  const posted = ok(curl('curl -X POST --upload-file ./report.json https://h/v1/files'));
  assert.equal(posted.ref.method, 'POST');
});

test('curl: URL forms — variable base, {{var}}, bare host with port', () => {
  assert.equal(ok(curl('curl $API_URL/v1/x')).ref.url, '$API_URL/v1/x');
  assert.equal(ok(curl('curl "${API}/v1/x"')).ref.url, '${API}/v1/x');
  assert.equal(ok(curl('curl {{baseUrl}}/v1/x')).ref.url, '{{baseUrl}}/v1/x');
  assert.equal(ok(curl('curl localhost:3000/api/x')).ref.url, 'localhost:3000/api/x');
});

// ------------------------------------------------------------------- HTTP --

test('http: request line, Host header and a JSON body', () => {
  const r = ok(parseHttpRequest(['POST /v1/customers HTTP/1.1', 'Host: api.x.test', 'Content-Type: application/json', '', '{"email": "a@b", "name": "A"}']));
  assert.equal(r.ref.method, 'POST');
  assert.equal(r.ref.url, 'https://api.x.test/v1/customers');
  assert.deepEqual(r.ref.body?.keys, ['email', 'name']);
});

test('http: form body and query string', () => {
  const r = ok(parseHttpRequest(['POST /v1/charges?expand=x', 'Content-Type: application/x-www-form-urlencoded', '', 'amount=1&currency=usd']));
  assert.deepEqual(r.ref.query, ['expand']);
  assert.deepEqual(r.ref.body, { encoding: 'form', keys: ['amount', 'currency'], complete: true });
});

test('http: a non-request first line is unparsed', () => {
  assert.equal(parseHttpRequest(['FETCH the thing']).ok, false);
});

test('http blocks: responses are not calls; REST Client ### separates requests', () => {
  const r = scanMarkdown(md('```http', 'HTTP/1.1 200 OK', 'Content-Type: application/json', '```', '```http', 'GET /a', '###', 'DELETE /b', '```'), 'f.md');
  assert.deepEqual(
    r.references.map((x) => `${x.method} ${x.url} @${x.line}`),
    ['GET /a @6', 'DELETE /b @8']
  );
  assert.equal(r.unparsed.length, 0);
});

// ------------------------------------------------------------------ fetch --

test('fetch: template URL, method and JSON.stringify keys', () => {
  const r = ok(parseFetchArgs(['`${BASE}/v1/users/${id}`', "{ method: 'PATCH', headers: { a: 'b' }, body: JSON.stringify({ name, 'email': e, age: 3 }) }"]));
  assert.equal(r.ref.method, 'PATCH');
  assert.equal(r.ref.url, '{BASE}/v1/users/{id}');
  assert.deepEqual(r.ref.body, { encoding: 'json', keys: ['name', 'email', 'age'], complete: true });
});

test('fetch: no options is a GET; a spread in the body is incomplete', () => {
  assert.equal(ok(parseFetchArgs(["'https://h/x'"])).ref.method, 'GET');
  const r = ok(parseFetchArgs(["'https://h/x'", "{ method: 'POST', body: JSON.stringify({ ...defaults, a: 1 }) }"]));
  assert.deepEqual(r.ref.body, { encoding: 'json', keys: ['a'], complete: false });
});

test('fetch: string concatenation with a base variable', () => {
  assert.equal(ok(parseFetchArgs(["API_URL + '/v1/x/' + id"])).ref.url, '{API_URL}/v1/x/{id}');
});

test('fetch: unparsed for a URL variable, a computed method or spread options', () => {
  assert.equal(parseFetchArgs(['url']).ok, false);
  assert.equal(parseFetchArgs(["'https://h/x'", '{ method: m }']).ok, false);
  assert.equal(parseFetchArgs(["'https://h/x'", 'options']).ok, false);
  assert.equal(parseFetchArgs(["'https://h/x'", '{ ...opts }']).ok, false);
});

test('fetch: a spread anywhere in the options object is unparsed, even with an explicit method and body', () => {
  // A spread can override method/body no matter where it sits textually, so
  // the explicit method/body written right there are not trustworthy either.
  const before = parseFetchArgs(["'https://h/x'", "{ ...defaults, method: 'POST', body: JSON.stringify({ a: 1 }) }"]);
  assert.equal(before.ok, false);
  const after = parseFetchArgs(["'https://h/x'", "{ method: 'POST', body: JSON.stringify({ a: 1 }), ...overrides }"]);
  assert.equal(after.ok, false);
});

test('fetch: JSON.stringify(variable) keeps the call, body unread', () => {
  const r = ok(parseFetchArgs(["'https://h/x'", "{ method: 'POST', body: JSON.stringify(payload) }"]));
  assert.equal(r.ref.body?.keys, null);
});

test('fetch in a block: calls in comments and strings are not calls; .fetch( is not fetch(', () => {
  const r = scanMarkdown(
    md(
      '```js',
      "const docs = 'https://example.com'; // fetch('/nope')",
      "/* fetch('/also-nope') */",
      "const s = \"fetch('/in-a-string')\";",
      "client.fetch('/not-global');",
      "await fetch('https://api.x.test/v1/ok');",
      '```'
    ),
    'f.md'
  );
  assert.deepEqual(r.references.map((x) => `${x.method} ${x.url} @${x.line}`), ['GET https://api.x.test/v1/ok @6']);
});

// ----------------------------------------------------------------- python --

test('python: requests.<method> with params= and json=', () => {
  const r = ok(parsePythonArgs('post', ['"https://h/v1/c"', 'params={"expand": "x"}', 'json={"email": e, "name": n}', 'headers=h']));
  assert.equal(r.ref.method, 'POST');
  assert.deepEqual(r.ref.query, ['expand']);
  assert.deepEqual(r.ref.body, { encoding: 'json', keys: ['email', 'name'], complete: true });
});

test('python: f-string URL, data= dict is form, dict(...) keys, json.dumps', () => {
  assert.equal(ok(parsePythonArgs('get', ['f"{BASE_URL}/v1/c/{cid}"'])).ref.url, '{BASE_URL}/v1/c/{cid}');
  assert.deepEqual(ok(parsePythonArgs('post', ['"https://h/x"', 'data={"a": 1}'])).ref.body, { encoding: 'form', keys: ['a'], complete: true });
  assert.deepEqual(ok(parsePythonArgs('post', ['"https://h/x"', 'json=dict(a=1, b=2)'])).ref.body?.keys, ['a', 'b']);
  assert.deepEqual(ok(parsePythonArgs('post', ['"https://h/x"', 'data=json.dumps({"a": 1})'])).ref.body, { encoding: 'json', keys: ['a'], complete: true });
});

test('python: requests.request("METHOD", url) and keyword url=', () => {
  assert.equal(ok(parsePythonArgs('request', ['"DELETE"', '"https://h/x"'])).ref.method, 'DELETE');
  assert.equal(ok(parsePythonArgs('get', ['url="https://h/x"'])).ref.url, 'https://h/x');
});

test('python: unparsed for a URL variable, **kwargs, or a computed method', () => {
  assert.equal(parsePythonArgs('get', ['url']).ok, false);
  assert.equal(parsePythonArgs('get', ['"https://h/x"', '**kw']).ok, false);
  assert.equal(parsePythonArgs('request', ['method', '"https://h/x"']).ok, false);
});

test('python: a second positional argument to post/put/patch/request is the body (data), a dict literal checked like data=', () => {
  const posted = ok(parsePythonArgs('post', ['"https://h/x"', '{"a": 1, "b": 2}']));
  assert.deepEqual(posted.ref.body, { encoding: 'form', keys: ['a', 'b'], complete: true });
  const requested = ok(parsePythonArgs('request', ['"POST"', '"https://h/x"', '{"a": 1}']));
  assert.deepEqual(requested.ref.body, { encoding: 'form', keys: ['a'], complete: true });
  const notDict = ok(parsePythonArgs('put', ['"https://h/x"', 'payload']));
  assert.equal(notDict.ref.body?.keys, null);
  assert.match(notDict.ref.body?.unread ?? '', /second positional argument/);
  // GET's second positional is `params=` (by position), not a body — this
  // check does not invent a body for verbs that do not send request bodies.
  assert.equal(ok(parsePythonArgs('get', ['"https://h/x"', 'params'])).ref.body, null);
});

test('python: params= that is not a dict literal is unread, counted like a body not read', () => {
  const r = ok(parsePythonArgs('get', ['"https://h/v1/c"', 'params=filters']));
  assert.equal(r.ref.query, null);
  assert.match(r.ref.queryUnread ?? '', /params=/);
});

test('python: a dict with a non-literal key or **spread is incomplete', () => {
  const r = ok(parsePythonArgs('post', ['"https://h/x"', 'json={"a": 1, KEY: 2, **extra}']));
  assert.deepEqual(r.ref.body, { encoding: 'json', keys: ['a'], complete: false });
});

test('python in a block: a multi-line call is found at its first line; comments are skipped', () => {
  const r = scanMarkdown(
    md('```python', 'import requests', '# requests.get("https://h/commented")', 'r = requests.post(', '    "https://api.x.test/v1/c",', '    json={"a": 1},', ')', '```'),
    'f.md'
  );
  assert.deepEqual(r.references.map((x) => `${x.method} ${x.url} @${x.line}`), ['POST https://api.x.test/v1/c @4']);
});

// ------------------------------------------------------------------ prose --

test('prose: backticked and plain METHOD /path, trailing punctuation dropped', () => {
  assert.deepEqual(
    proseReferences('Call `GET /v1/customers/{id}`, then POST /v1/charges. Also DELETE /v1/x/<id>!').map((r) => `${r.method} ${r.url}`),
    ['GET /v1/customers/{id}', 'POST /v1/charges', 'DELETE /v1/x/<id>']
  );
});

test('prose: a full URL after the method; lowercase and embedded words are not methods', () => {
  assert.deepEqual(proseReferences('GET https://api.x.test/v1/a').map((r) => r.url), ['https://api.x.test/v1/a']);
  assert.deepEqual(proseReferences('we get /tmp files; FORGET /x; X-GET /y'), []);
});

test('queryKeysOf: placeholders are not names; none is null', () => {
  assert.deepEqual(queryKeysOf('/x?a=1&{k}=2&b'), ['a', 'b']);
  assert.equal(queryKeysOf('/x'), null);
});

test('queryOf: a bare variable token in the query string is unread, not silently dropped like a placeholder-named pair', () => {
  const r = queryOf('/x?a=1&{filters}');
  assert.deepEqual(r.keys, ['a']);
  assert.match(r.unread ?? '', /variable/);
  assert.equal(queryOf('/x?a=1&b=2').unread, undefined);
});

// --------------------------------------------------------------- markdown --

test('markdown: front matter, HTML comments and MDX comments are not prose', () => {
  const r = scanMarkdown(md('---', 'endpoint: GET /front', '---', '<!-- GET /hidden -->', '{/* GET /mdx */}', 'GET /shown'), 'f.md');
  assert.deepEqual(r.references.map((x) => x.url), ['/shown']);
});

test('markdown: an apibreak-ignore marker covers the next block or line; ignore-file covers everything', () => {
  const r = scanMarkdown(md('<!-- apibreak-ignore -->', '', '```bash', 'curl https://h/a', '```', '<!-- apibreak-ignore -->', 'GET /b', 'GET /c'), 'f.md');
  assert.deepEqual(r.references.map((x) => x.url), ['/c']);
  assert.equal(r.suppressed, 2);
  const f = scanMarkdown(md('<!-- apibreak-ignore-file -->', 'GET /a'), 'f.md');
  assert.equal(f.ignoredFile, true);
  assert.equal(f.references.length, 0);
});

test('markdown: apibreak-ignore-file only fires as a whole comment, never as a substring of prose or a URL', () => {
  const r = scanMarkdown(md('See GET /apibreak-ignore-filed for details.', 'GET /b'), 'f.md');
  assert.deepEqual(r.references.map((x) => x.url), ['/apibreak-ignore-filed', '/b']);
  assert.equal(r.ignoredFile, false);
  const fenced = scanMarkdown(md('<!-- apibreak-ignore-file -->', 'GET /a'), 'f.md');
  assert.equal(fenced.ignoredFile, true);
  const mdx = scanMarkdown(md('{/* apibreak-ignore-file */}', 'GET /a'), 'f.md');
  assert.equal(mdx.ignoredFile, true);
});

test('markdown: apibreak-ignore as a line-level marker requires the whole comment too, not a substring', () => {
  const r = scanMarkdown(md('See the apibreak-ignore-list below.', 'GET /a'), 'f.md');
  assert.deepEqual(r.references.map((x) => x.url), ['/a']);
  assert.equal(r.suppressed, 0);
});

test('markdown: a multi-line MDX or HTML comment is excluded from scanning entirely, with line numbers staying correct', () => {
  const r = scanMarkdown(
    md('{/*', 'GET /hidden-1', 'still hidden', '*/}', 'GET /shown', '<!--', 'GET /hidden-2', '-->', 'GET /shown-2'),
    'f.md'
  );
  assert.deepEqual(
    r.references.map((x) => `${x.url} @${x.line}`),
    ['/shown @5', '/shown-2 @9']
  );
});

test('markdown: curl in command position only, even past a quoted separator-looking string', () => {
  const r = scanMarkdown(md('```bash', 'echo "; curl /removed"', 'curl https://h/v1/a', '```'), 'f.md');
  assert.deepEqual(r.references.map((x) => `${x.method} ${x.url} @${x.line}`), ['GET https://h/v1/a @3']);
});

test('markdown: an indented fence inside a list item, ~~~ fences, info strings with attributes', () => {
  const { blocks } = splitMarkdown(md('1. Step', '   ```bash title="x"', '   curl https://h/a', '   ```', '~~~sh{1}', 'curl https://h/b', '~~~'));
  assert.deepEqual(blocks.map((b) => [b.lang, b.startLine, b.lines[0]]), [
    ['bash', 3, 'curl https://h/a'],
    ['sh', 6, 'curl https://h/b'],
  ]);
});

test('markdown: code in other languages (Go, JSON, YAML) is not read', () => {
  const r = scanMarkdown(md('```go', 'http.Get("https://h/a")', '```', '```json', '{"curl": "https://h/b"}', '```'), 'f.md');
  assert.equal(r.references.length + r.unparsed.length, 0);
});

test('markdown: curl in command position only, prompts stripped, continuations joined, line of the command', () => {
  const r = scanMarkdown(
    md('```console', 'echo "install curl first"', '$ curl -X POST \\', '    https://h/v1/a \\', "    -d 'x=1'", 'TOKEN=$(curl -s https://h/v1/token)', '```'),
    'f.md'
  );
  assert.deepEqual(r.references.map((x) => `${x.method} ${x.url} @${x.line}`), ['POST https://h/v1/a @3', 'GET https://h/v1/token @6']);
  assert.equal(r.unparsed.length, 0);
});

test('markdown: an unlabelled block with a bare request line is read as HTTP', () => {
  const r = scanMarkdown(md('```', 'GET /v1/a HTTP/1.1', '```'), 'f.md');
  assert.deepEqual(r.references.map((x) => `${x.source} ${x.url}`), ['http /v1/a']);
});
