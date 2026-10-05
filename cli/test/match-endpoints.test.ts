/**
 * Unit coverage for `pathPrefix` and `alignPaths`, the pre-diff pairing that
 * keeps a cosmetic spec edit — a placeholder rename, a trailing-slash
 * add/drop, or a path prefix that moved between `servers[].url`/`basePath`
 * and the path templates (including the APIs.guru synthetic-host case) —
 * from being reported as a removal-plus-addition. Pairing happens by
 * re-keying `paths` *before* the engine ever diffs an operation, so a paired
 * pair is actually compared field-by-field, not just spared a finding.
 * End-to-end coverage (through `runDiff`) lives in diff-cli.test.ts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignPaths, pathPrefix } from '../src/match-endpoints.js';

const op = (tag?: string): { responses: Record<string, unknown>; 'x-tag'?: string } => ({
  responses: {},
  ...(tag === undefined ? {} : { 'x-tag': tag }),
});

test('pathPrefix: basePath, a literal server, and a templated server with defaults', () => {
  assert.equal(pathPrefix({ basePath: '/v2/' }), '/v2');
  assert.equal(pathPrefix({ servers: [{ url: 'https://api.example.com/v1/' }] }), '/v1');
  assert.equal(
    pathPrefix({ servers: [{ url: '{scheme}://{host}/api', variables: { scheme: { default: 'https' }, host: { default: 'h' } } }] }),
    '/api'
  );
  assert.equal(pathPrefix({}), '');
});

test('pathPrefix: the APIs.guru synthetic x-providerName host is skipped, the real server used', () => {
  const doc = {
    info: { title: 'T', version: '1', 'x-providerName': 'm.local' },
    servers: [{ url: 'http://m.local' }, { url: 'http://h/api' }],
  };
  assert.equal(pathPrefix(doc), '/api');
});

test('alignPaths: no-op when the prefix is unchanged and nothing was renamed', () => {
  const oldDoc = { paths: { '/a': {} } };
  const newDoc = { paths: { '/a': {}, '/b': {} } };
  const r = alignPaths(oldDoc, newDoc);
  assert.equal(r.moved, 0);
  assert.equal(r.doc, newDoc);
});

test('alignPaths: a prefix that moved from servers to the path template is re-keyed under the old template', () => {
  const oldDoc = { servers: [{ url: 'https://h/v1/' }], paths: { '/lists/': {} } };
  const newDoc = { servers: [{ url: 'https://h/' }], paths: { '/v1/lists/': {} } };
  const r = alignPaths(oldDoc, newDoc);
  assert.equal(r.moved, 1);
  assert.deepEqual(Object.keys(r.doc.paths), ['/lists/']);
});

test('alignPaths: an unrelated new root path is never matched against an old root that moved away', () => {
  const oldDoc = { servers: [{ url: '/v1' }], paths: { '/': {} } };
  const newDoc = { servers: [{ url: '/' }], paths: { '/': {}, '/v1/': {} } };
  const r = alignPaths(oldDoc, newDoc);
  assert.equal(r.moved, 1);
  // /v1/ -> old key "/", and the new unrelated "/" gets a synthetic wire key.
  assert.deepEqual(new Set(Object.keys(r.doc.paths)), new Set(['/', '/[wire]/']));
});

test('alignPaths: a placeholder rename is paired even when the prefix did not move', () => {
  const oldDoc = { paths: { '/o/{id}': op() } };
  const newDoc = { paths: { '/o/{orderId}': op() } };
  const r = alignPaths(oldDoc, newDoc);
  assert.equal(r.moved, 1);
  assert.deepEqual(Object.keys(r.doc.paths), ['/o/{id}']);
});

test('alignPaths: a trailing slash added or dropped is paired even when the prefix did not move', () => {
  const oldDoc = { paths: { '/o/{id}': op() } };
  const newDoc = { paths: { '/o/{id}/': op() } };
  const r = alignPaths(oldDoc, newDoc);
  assert.equal(r.moved, 1);
  assert.deepEqual(Object.keys(r.doc.paths), ['/o/{id}']);
});

test('alignPaths: pairs across a server-prefix move, including the APIs.guru fake-host server', () => {
  const oldDoc = {
    info: { title: 'T', version: '1', 'x-providerName': 'm.local' },
    servers: [{ url: 'http://m.local' }, { url: 'https://h/v1' }],
    paths: { '/lists/{id}': op() },
  };
  const newDoc = { servers: [{ url: 'https://h/' }], paths: { '/v1/lists/{listId}': op() } };
  const r = alignPaths(oldDoc, newDoc);
  assert.equal(r.moved, 1);
  assert.deepEqual(Object.keys(r.doc.paths), ['/lists/{id}']);
});

// Regression (P1): the trailing-slash normalization used to collapse two
// distinct old paths ("/u" and "/u/") to the same trimmed wire key, and the
// second `oldByWire.set(...)` silently overwrote the first — so whichever new
// path was re-keyed second, its response field, landed on the *other* old
// operation and read as "response field removed". Exact (untrimmed) wire
// matching must be tried first and pair each one correctly.
test('alignPaths: a trailing-slash collision on the old side never invents a cross-pairing', () => {
  const oldDoc = {
    servers: [{ url: '/v1' }],
    paths: { '/u': op('a'), '/u/': op('b') },
  };
  const newDoc = {
    servers: [{ url: '' }],
    paths: { '/v1/u': op('a'), '/v1/u/': op('b') },
  };
  const r = alignPaths(oldDoc, newDoc);
  assert.equal(r.moved, 2);
  assert.deepEqual(new Set(Object.keys(r.doc.paths)), new Set(['/u', '/u/']));
  // Each new path must have been re-keyed under the old path with the SAME
  // wire address, not whichever old path happened to be indexed last.
  assert.equal((r.doc.paths['/u'] as { 'x-tag': string })['x-tag'], 'a');
  assert.equal((r.doc.paths['/u/'] as { 'x-tag': string })['x-tag'], 'b');
});

// Regression (P2): a path- or operation-level `servers` override pins an
// operation to its own address regardless of where the *root* server moves.
// Re-keying it by the root prefix anyway invented a phantom removal: the
// operation kept its literal path in both documents, but was rekeyed to an
// unmatchable synthetic `[wire]...` key because the root prefix differed.
test('alignPaths: an operation-level servers override is never re-keyed by the root prefix move', () => {
  const fixed = { get: { servers: [{ url: '/fixed' }], responses: {} } };
  const oldDoc = { servers: [{ url: '/v1' }], paths: { '/u': fixed } };
  const newDoc = { servers: [{ url: '/v2' }], paths: { '/u': fixed } };
  const r = alignPaths(oldDoc, newDoc);
  assert.deepEqual(Object.keys(r.doc.paths), ['/u']);
  assert.equal(r.doc.paths['/u'], fixed);
});

test('alignPaths: a path-level servers override is never re-keyed by the root prefix move', () => {
  const item = { servers: [{ url: '/fixed' }], get: { responses: {} } };
  const oldDoc = { servers: [{ url: '/v1' }], paths: { '/u': item } };
  const newDoc = { servers: [{ url: '/v2' }], paths: { '/u': item } };
  const r = alignPaths(oldDoc, newDoc);
  assert.deepEqual(Object.keys(r.doc.paths), ['/u']);
});

// Regression (follow-up review, 2026-09-30): a placeholder rename ("{id}" ->
// "{orderId}") is paired at the PATH level, but the operation's own `in:
// path` parameter still declares itself under the NEW name. Left alone, the
// engine compares the old operation's "id" parameter against the new
// operation's "orderId" parameter by name, finds no old-side counterpart for
// "orderId", and reports it as newly added and required — a false positive
// for a rename that changes nothing on the wire. The Nth placeholder on one
// side must be reconciled with the Nth placeholder on the other, so the
// paired operations compare the SAME parameter.
test('alignPaths: a renamed path placeholder renames its own "in: path" parameter to match, positionally', () => {
  const oldDoc = {
    paths: {
      '/o/{id}': {
        delete: {
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {},
        },
      },
    },
  };
  const newDoc = {
    paths: {
      '/o/{orderId}': {
        delete: {
          parameters: [{ name: 'orderId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {},
        },
      },
    },
  };
  const r = alignPaths(oldDoc, newDoc);
  assert.equal(r.moved, 1);
  const item = r.doc.paths['/o/{id}'] as { delete: { parameters: Array<{ name: string; in: string }> } };
  assert.deepEqual(item.delete.parameters, [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }]);
});

// The same rename must reach a path-item-level (not just operation-level)
// parameter declaration, and must not touch a query parameter that happens
// to share a name with a placeholder elsewhere.
test('alignPaths: a positional path-parameter rename reaches path-item-level parameters and spares query params', () => {
  const oldDoc = {
    paths: {
      '/o/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        get: { parameters: [{ name: 'orderId', in: 'query', schema: { type: 'string' } }], responses: {} },
      },
    },
  };
  const newDoc = {
    paths: {
      '/o/{orderId}': {
        parameters: [{ name: 'orderId', in: 'path', required: true, schema: { type: 'string' } }],
        get: { parameters: [{ name: 'orderId', in: 'query', schema: { type: 'string' } }], responses: {} },
      },
    },
  };
  const r = alignPaths(oldDoc, newDoc);
  const item = r.doc.paths['/o/{id}'] as {
    parameters: Array<{ name: string; in: string }>;
    get: { parameters: Array<{ name: string; in: string }> };
  };
  assert.deepEqual(item.parameters, [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }]);
  // The query parameter named "orderId" is untouched — only `in: path` entries are renamed.
  assert.deepEqual(item.get.parameters, [{ name: 'orderId', in: 'query', schema: { type: 'string' } }]);
});

// Round-2 follow-up review, 2026-09-30: a positional rename requires a
// BIJECTION across all placeholder positions — each new name must correspond
// to exactly one old name and vice versa. Two positions on the new side
// reusing the same name for two DIFFERENT old-side names cannot be
// positionally renamed by name (the rename would collide with itself), so
// the whole cosmetic pairing for this path must be refused, not guessed at.
test('alignPaths: a new side reusing one placeholder name across two different old names is never cosmetically paired', () => {
  const oldDoc = { paths: { '/o/{a}/{b}': op() } };
  const newDoc = { paths: { '/o/{z}/{z}': op() } };
  const r = alignPaths(oldDoc, newDoc);
  assert.equal(r.moved, 0);
  assert.deepEqual(Object.keys(r.doc.paths), ['/o/{z}/{z}']);
});

// The same conflict in the other direction: the OLD side reuses one name
// across two positions that the new side gives different names — including
// this case is what "including unchanged names" means: a repeat is a
// conflict even where the position that happens to match is unchanged.
test('alignPaths: an old side reusing one placeholder name across two different new names is never cosmetically paired', () => {
  const oldDoc = { paths: { '/o/{a}/{a}': op() } };
  const newDoc = { paths: { '/o/{x}/{y}': op() } };
  const r = alignPaths(oldDoc, newDoc);
  assert.equal(r.moved, 0);
  assert.deepEqual(Object.keys(r.doc.paths), ['/o/{x}/{y}']);
});

// A repeat that is consistent on both sides (the same position-for-position
// correspondence every time it recurs) is a real bijection and still pairs.
test('alignPaths: a placeholder name repeated consistently on both sides still pairs, and still renames', () => {
  const oldDoc = { paths: { '/o/{a}/{a}': op() } };
  const newDoc = { paths: { '/o/{z}/{z}': op() } };
  const r = alignPaths(oldDoc, newDoc);
  assert.equal(r.moved, 1);
  assert.deepEqual(Object.keys(r.doc.paths), ['/o/{a}/{a}']);
});

// Round-3 gave a path split into an effective-servers group (see history)
// special handling so its root and override halves could both match back to
// the same old key. Round-4 deleted that machinery: it was the source of a
// real false positive (a prefix-move realignment colliding with an
// unrelated override — see the "never confidently paired" test below), and
// the simpler, safe rule is that ANY servers override anywhere in either
// document disables prefix-move realignment for the WHOLE document. Old
// "/x" here carries an operation-level override on DELETE; because that
// override exists, the new side's root-prefix-moved GET ("/v1/x") is no
// longer chased back to old "/x" at all — it is an ordinary addition, and
// old "/x"'s own GET (absent from the new "/x") is an ordinary removal. Only
// the unchanged, literally-same-key DELETE still pairs.
test('alignPaths: a servers override anywhere disables prefix-move realignment for the whole document', () => {
  const oldDoc = {
    servers: [{ url: '/v1' }],
    paths: {
      '/x': {
        get: { responses: {} },
        delete: { servers: [{ url: '/ov' }], responses: {} },
      },
    },
  };
  const newDoc = {
    servers: [{ url: '' }],
    paths: {
      '/v1/x': { get: { responses: {} } },
      '/x': { delete: { servers: [{ url: '/ov' }], responses: {} } },
    },
  };
  const r = alignPaths(oldDoc, newDoc);
  const keys = new Set(Object.keys(r.doc.paths));
  assert.deepEqual(keys, new Set(['/v1/x', '/x']));
  const moved = r.doc.paths['/v1/x'] as { get?: unknown };
  const kept = r.doc.paths['/x'] as { get?: unknown; delete?: unknown };
  assert.equal(moved.get !== undefined, true);
  assert.equal(kept.delete !== undefined, true);
  assert.equal(kept.get, undefined);
  assert.equal(r.ambiguous.size, 0);
});

// Round-3 follow-up review, 2026-09-30 (bullet 2, the unsafe case): old "/u"
// has ONLY a root GET (no override anywhere). The new side moves it under
// the root-prefix move to literal "/v1/u", which matches old "/u" — a real
// pairing. Separately and UNRELATED, a brand-new operation on the new side
// happens to declare its own "servers" override with no old-side
// counterpart at all, and happens to be declared under literal path "/u" —
// so it falls back to keeping its own name "/u", purely by coincidence, not
// because it is paired with anything. The fallback's destKey now collides
// with the real match's destKey, but the two are NOT the same original
// path — reserving destinations must refuse the collision and give each
// its own literal key, never let the coincidence silently win.
test('alignPaths: a real match and an unrelated fallback that coincidentally share a destination never merge', () => {
  const oldDoc = {
    servers: [{ url: '/v1' }],
    paths: {
      '/u': { get: { responses: {} } },
    },
  };
  const newDoc = {
    servers: [{ url: '' }],
    paths: {
      '/v1/u': { get: { responses: {} } },
      '/u': { post: { servers: [{ url: '/ov' }], responses: {} } },
    },
  };
  const r = alignPaths(oldDoc, newDoc);
  const keys = new Set(Object.keys(r.doc.paths));
  assert.equal(keys.has('/v1/u'), true);
  assert.equal(keys.has('/u'), true);
  const moved = (r.doc.paths as Record<string, { get?: unknown }>)['/v1/u'];
  const fallback = (r.doc.paths as Record<string, { post?: unknown }>)['/u'];
  assert.equal(moved?.get !== undefined, true);
  assert.equal(fallback?.post !== undefined, true);
});

// Round-3 gave a `servers` override per-OPERATION scope, so a pinned GET
// would not exempt its POST sibling from root-prefix realignment. Round-4
// simplified this: an override anywhere in the document disables
// prefix-move realignment for the WHOLE document (see the doc comment on
// `alignPaths`). The pinned GET still pairs (it kept its own literal key on
// both sides); the POST, which moved with the root prefix, is now an
// ordinary removal-and-addition rather than being cleverly re-paired.
test('alignPaths: a servers override on one method also stops root-prefix pairing for its sibling', () => {
  const oldDoc = {
    servers: [{ url: '/v1' }],
    paths: {
      '/u': {
        get: { servers: [{ url: '/fixed' }], responses: {} },
        post: { responses: {} },
      },
    },
  };
  const newDoc = {
    servers: [{ url: '' }],
    paths: {
      '/u': { get: { servers: [{ url: '/fixed' }], responses: {} } },
      '/v1/u': { post: { responses: {} } },
    },
  };
  const r = alignPaths(oldDoc, newDoc);
  const kept = (r.doc.paths as Record<string, { get?: unknown; post?: unknown }>)['/u'];
  const added = (r.doc.paths as Record<string, { get?: unknown; post?: unknown }>)['/v1/u'];
  assert.equal(kept?.get !== undefined, true);
  assert.equal(kept?.post, undefined);
  assert.equal(added?.post !== undefined, true);
});

// Round-3 follow-up review, 2026-09-30 (bullet 5, other half): an override
// that did NOT change between old and new must not block a legitimate
// placeholder rename happening underneath it.
// Round-4 follow-up review, 2026-09-30 (bullet 3, reproducer 2 as literally
// described): the override sits on a DIFFERENT, unrelated operation from the
// one being renamed — not on the renamed operation itself, as the test
// above exercises (a strictly harder case, since the renamed operation's own
// address never moves). The rename must still work.
test('alignPaths: a placeholder rename still works when a servers override exists elsewhere in the document', () => {
  const oldDoc = {
    paths: {
      '/o/{id}': { get: { responses: {} } },
      '/pinned': { get: { servers: [{ url: '/fixed' }], responses: {} } },
    },
  };
  const newDoc = {
    paths: {
      '/o/{orderId}': { get: { responses: {} } },
      '/pinned': { get: { servers: [{ url: '/fixed' }], responses: {} } },
    },
  };
  const r = alignPaths(oldDoc, newDoc);
  assert.equal(r.moved, 1);
  assert.deepEqual(new Set(Object.keys(r.doc.paths)), new Set(['/o/{id}', '/pinned']));
  assert.equal(r.ambiguous.size, 0);
});

// Round-4 follow-up review, 2026-09-30 (bullet 3, reproducer 3): an
// operation's effective server address (operation > path item > root)
// differs between the two documents. `server_changed` names it, keyed
// "METHOD key" at the FINAL (post-alignment) key.
test('alignPaths: serverChanged names an operation whose operation-level override moved', () => {
  const oldDoc = { paths: { '/x': { get: { servers: [{ url: '/a' }], responses: {} } } } };
  const newDoc = { paths: { '/x': { get: { servers: [{ url: '/b' }], responses: {} } } } };
  const r = alignPaths(oldDoc, newDoc);
  assert.deepEqual(r.serverChanged, new Set(['GET /x']));
});

test('alignPaths: serverChanged names an operation whose path-item-level override moved', () => {
  const oldDoc = { paths: { '/x': { servers: [{ url: '/a' }], get: { responses: {} } } } };
  const newDoc = { paths: { '/x': { servers: [{ url: '/b' }], get: { responses: {} } } } };
  const r = alignPaths(oldDoc, newDoc);
  assert.deepEqual(r.serverChanged, new Set(['GET /x']));
});

test('alignPaths: serverChanged fires when an override is dropped and the operation falls through to the (different) root', () => {
  const oldDoc = { servers: [{ url: '/v1' }], paths: { '/x': { get: { servers: [{ url: '/ov' }], responses: {} } } } };
  const newDoc = { servers: [{ url: '/v1' }], paths: { '/x': { get: { responses: {} } } } };
  const r = alignPaths(oldDoc, newDoc);
  assert.deepEqual(r.serverChanged, new Set(['GET /x']));
});

// An unchanged effective address — whether via a matching override or via an
// unchanged root — must never be reported.
test('alignPaths: serverChanged is empty when the effective address is unchanged', () => {
  const servers = [{ url: '/fixed' }];
  const oldDoc = { paths: { '/x': { get: { servers, responses: {} } } } };
  const newDoc = { paths: { '/x': { get: { servers, responses: {} } } } };
  const r = alignPaths(oldDoc, newDoc);
  assert.equal(r.serverChanged.size, 0);
});

// Round-5 review, P1 (bullet 1): even while realignment is skipped for the
// whole document (a servers override exists somewhere else — here on
// GET /health), a plain root-prefix move between two otherwise-unmatched
// operations should still be recognisable as a *possible* pairing, so the
// caller can report ONE `possibly_moved` finding instead of an ordinary
// removal on one side plus an ordinary addition on the other. GET /health
// itself (its own server changed) is untouched by this — it keeps pairing at
// its own literal key, same as before.
test('alignPaths: possiblyMoved pairs an unmatched root-prefix-moved operation even when realignment is skipped', () => {
  const oldDoc = {
    servers: [{ url: '/v1' }],
    paths: {
      '/pets': { get: { responses: {} } },
      '/health': { get: { servers: [{ url: '/internal' }], responses: {} } },
    },
  };
  const newDoc = {
    servers: [{ url: '/' }],
    paths: {
      '/v1/pets': { get: { responses: {} } },
      '/health': { get: { servers: [{ url: '/internal' }], responses: {} } },
    },
  };
  const r = alignPaths(oldDoc, newDoc);
  // Realignment was skipped: the new document keeps its own literal keys
  // (the old document, `/pets` included, is unaffected and read separately).
  assert.deepEqual(new Set(Object.keys(r.doc.paths)), new Set(['/v1/pets', '/health']));
  assert.equal(r.possiblyMoved.get('GET /pets'), 'GET /v1/pets');
  assert.equal(r.possiblyMoved.get('GET /v1/pets'), 'GET /pets');
  // GET /health is unrelated to the pairing — it keeps its own literal key
  // on both sides, at an unchanged effective address.
  assert.equal(r.possiblyMoved.has('GET /health'), false);
  assert.equal(r.serverChanged.size, 0);
});

test('alignPaths: possiblyMoved is empty when realignment ran normally (no override anywhere)', () => {
  const oldDoc = { servers: [{ url: '/v1' }], paths: { '/pets': { get: { responses: {} } } } };
  const newDoc = { servers: [{ url: '/' }], paths: { '/v1/pets': { get: { responses: {} } } } };
  const r = alignPaths(oldDoc, newDoc);
  // Realignment ran normally: the operation is already paired by the ordinary route.
  assert.equal(r.moved, 1);
  assert.equal(r.possiblyMoved.size, 0);
});

// Round-6 review, P1: the possiblyMoved candidate step used to pair whole
// PATH ITEMS (old "/users" <-> new "/v1/users") and then sweep every method
// they both happen to declare into possiblyMoved uniformly. GET has no
// override and genuinely follows the document's root-prefix move. POST has
// its OWN operation-level override ("/", unchanged across both documents) —
// its true effective address is judged on its own terms, not on the item's
// root-prefix arithmetic, so it must never be dragged into GET's pairing.
test('alignPaths: possiblyMoved pairs per (path, method) — a sibling method with its own unchanged override is not swept into another method\'s root-prefix pairing', () => {
  const oldDoc = {
    servers: [{ url: '/v1' }],
    paths: {
      '/users': { get: { responses: {} }, post: { servers: [{ url: '/legacy' }], responses: {} } },
    },
  };
  const newDoc = {
    servers: [{ url: '/' }],
    paths: {
      '/v1/users': { get: { responses: {} }, post: { servers: [{ url: '/legacy' }], responses: {} } },
    },
  };
  const r = alignPaths(oldDoc, newDoc);
  assert.equal(r.possiblyMoved.get('GET /users'), 'GET /v1/users');
  assert.equal(r.possiblyMoved.get('GET /v1/users'), 'GET /users');
  assert.equal(r.possiblyMoved.has('POST /users'), false);
  assert.equal(r.possiblyMoved.has('POST /v1/users'), false);
});

test('alignPaths: an unchanged servers override does not block a placeholder rename underneath it', () => {
  const fixedServers = [{ url: '/fixed' }];
  const oldDoc = {
    paths: {
      '/o/{id}': { get: { servers: fixedServers, responses: {} } },
    },
  };
  const newDoc = {
    paths: {
      '/o/{orderId}': { get: { servers: fixedServers, responses: {} } },
    },
  };
  const r = alignPaths(oldDoc, newDoc);
  assert.equal(r.moved, 1);
  assert.deepEqual(Object.keys(r.doc.paths), ['/o/{id}']);
});

test('alignPaths: a root server path change with unchanged templates pairs them literally and reports it', () => {
  const oldDoc = { servers: [{ url: '/v3' }], paths: { '/pet': op('a'), '/gone': op('g') } };
  const newDoc = { servers: [{ url: 'https://h/api/v3' }], paths: { '/pet': op('a'), '/new': op('n') } };
  const r = alignPaths(oldDoc, newDoc);
  assert.deepEqual(new Set(Object.keys(r.doc.paths)), new Set(['/pet', '/new']));
  assert.deepEqual(r.rootPrefixChanged, { from: '/v3', to: '/api/v3', paired: 1 });
});

test('alignPaths: a wire match always wins over a literal template pairing', () => {
  // New "/v1/u" wire-matches old "/u" (prefix moved into the template); new
  // "/u" has the same template text as old "/u" but that key is now claimed.
  const oldDoc = { servers: [{ url: '/v1' }], paths: { '/u': op('moved') } };
  const newDoc = { servers: [{ url: '' }], paths: { '/u': op('other'), '/v1/u': op('moved') } };
  const r = alignPaths(oldDoc, newDoc);
  assert.equal((r.doc.paths['/u'] as { 'x-tag': string })['x-tag'], 'moved');
  assert.ok(Object.keys(r.doc.paths).some((k) => k.startsWith('/[wire]')));
  assert.equal(r.rootPrefixChanged, undefined);
});
