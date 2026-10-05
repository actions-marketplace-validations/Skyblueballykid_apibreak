import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml, YamlParseError } from '../src/yaml.js';

test('block mapping and nested mapping', () => {
  const doc = parseYaml(`
openapi: 3.0.0
info:
  title: Demo
  version: "1.0"
`);
  assert.deepEqual(doc, { openapi: '3.0.0', info: { title: 'Demo', version: '1.0' } });
});

test('block sequence at deeper indent than its key', () => {
  const doc = parseYaml(`
tags:
  - name: pet
    description: Pets
  - name: store
`);
  assert.deepEqual(doc, {
    tags: [
      { name: 'pet', description: 'Pets' },
      { name: 'store' },
    ],
  });
});

test('block sequence at the same indent as its key', () => {
  const doc = parseYaml(`
servers:
- url: /api/v3
tags:
- name: pet
  description: Pets
`);
  assert.deepEqual(doc, {
    servers: [{ url: '/api/v3' }],
    tags: [{ name: 'pet', description: 'Pets' }],
  });
});

test('a dash whose value is itself a nested sequence (two levels of dash)', () => {
  const doc = parseYaml(`
security:
- petstore_auth:
  - write:pets
  - read:pets
`);
  assert.deepEqual(doc, { security: [{ petstore_auth: ['write:pets', 'read:pets'] }] });
});

test('quoted keys, including numeric-looking ones', () => {
  const doc = parseYaml(`
responses:
  "200":
    description: ok
  '404':
    description: missing
`);
  assert.deepEqual(doc, { responses: { '200': { description: 'ok' }, '404': { description: 'missing' } } });
});

test('a value containing an unquoted colon is not mis-split as a mapping', () => {
  const doc = parseYaml('url: https://example.com/path?x=1');
  assert.deepEqual(doc, { url: 'https://example.com/path?x=1' });
});

test('literal block scalar preserves line breaks', () => {
  const doc = parseYaml(`
description: |
  line one
  line two
`);
  assert.deepEqual(doc, { description: 'line one\nline two\n' });
});

test('folded block scalar with strip chomping', () => {
  const doc = parseYaml(`
description: >-
  one two
  three
`);
  assert.deepEqual(doc, { description: 'one two three' });
});

test('a block scalar introduced by a dash is indented past the dash, not past the indicator', () => {
  // Real shape from Stripe's published openapi/spec3.yaml: a long enum member
  // wrapped onto its own line, indented one stop past "- ", the same column
  // the ">-" indicator itself sits at.
  const doc = parseYaml(`
enum:
  - short_one
  - >-
    a_very_long_enum_member_name
  - short_two
`);
  assert.deepEqual(doc, { enum: ['short_one', 'a_very_long_enum_member_name', 'short_two'] });
});

test('a double-quoted scalar spanning two physical lines with a continuation backslash', () => {
  const doc = parseYaml('description: "Provide tags as comma separated strings. Use\\\n  \\ tag1, tag2 for testing."') as {
    description: string;
  };
  assert.equal(doc.description, 'Provide tags as comma separated strings. Use tag1, tag2 for testing.');
});

test('flow sequences and mappings', () => {
  const doc = parseYaml('required: [a, b, c]\nempty: []\nobj: {x: 1, y: two}');
  assert.deepEqual(doc, { required: ['a', 'b', 'c'], empty: [], obj: { x: 1, y: 'two' } });
});

test('comments are stripped outside quotes and left alone inside them', () => {
  const doc = parseYaml(`
# a leading comment
name: value # trailing comment
literal: "not a # comment"
`);
  assert.deepEqual(doc, { name: 'value', literal: 'not a # comment' });
});

test('scalar types: null, booleans, integers, floats', () => {
  const doc = parseYaml(`
a: null
b: ~
c: true
d: false
e: 42
f: -3.5
g: plain string
`);
  assert.deepEqual(doc, { a: null, b: null, c: true, d: false, e: 42, f: -3.5, g: 'plain string' });
});

test('an empty document is null', () => {
  assert.equal(parseYaml(''), null);
  assert.equal(parseYaml('\n\n'), null);
});

test('an unterminated quoted scalar is a clear parse error, not a hang or a guess', () => {
  assert.throws(() => parseYaml('name: "unterminated'), YamlParseError);
});

test('a tab used for indentation is refused', () => {
  assert.throws(() => parseYaml('a:\n\tb: 1'), YamlParseError);
});

// CHANGED (follow-up review, 2026-09-30, switch to the `yaml` package): a
// multi-line plain scalar is ordinary, spec-legal YAML — the fold rule is the
// same one a double-quoted or block scalar uses (an internal line break
// becomes a single space). The hand-written line-based parser used to be
// unable to tell a folded continuation apart from the next mapping key
// starting, so it refused the whole document rather than risk parsing it
// wrong (see the git history of this test for that regression). A
// spec-conformant parser resolves it correctly instead, and does not lose
// anything after it, so the old "refuse the whole document" behaviour no
// longer applies: this is the exact case named in the follow-up review as
// one to re-run and confirm now parses.
test('a multi-line plain (unquoted) scalar folds to one space-joined line, not a parse error', () => {
  const doc = `
paths:
  /a:
    get:
      summary: ok
      description: Retrieve the thing. Filter the results by name if
        the \`name\` query parameter is specified.
      operationId: getThing
  /b:
    get:
      summary: also ok
`;
  assert.deepEqual(parseYaml(doc), {
    paths: {
      '/a': {
        get: {
          summary: 'ok',
          description: 'Retrieve the thing. Filter the results by name if the `name` query parameter is specified.',
          operationId: 'getThing',
        },
      },
      '/b': { get: { summary: 'also ok' } },
    },
  });
});

test('an anchor is a clear parse error, not a silent string value', () => {
  // Real-world regression: `op: &shared\n  responses: {}` used to become the
  // plain string "&shared", so the whole operation read as a string where an
  // object belongs and was reported removed.
  assert.throws(() => parseYaml('op: &shared\n  responses: {}\n'), YamlParseError);
});

test('an alias is a clear parse error, not a silent string value', () => {
  assert.throws(() => parseYaml('a: &x\n  responses: {}\nb: *x\n'), YamlParseError);
});

// CHANGED (follow-up review, 2026-09-30, switch to the `yaml` package): an
// explicit `!!str` tag is ordinary YAML 1.2 core-schema syntax — it forces
// the scalar to resolve as a string, which "foo" already would without it.
// The hand-written parser refused every tag outright because it had no
// tag-resolution logic at all, not because `!!str` is unsafe; a
// spec-conformant parser resolves it per schema instead of refusing it.
// Anchors and aliases remain hard refusals (see the two tests above): unlike
// a tag, those expand content that is not written where the diff is
// looking, which is the actual risk this file guards against.
test('an explicit core-schema tag resolves per schema, not as a parse error', () => {
  assert.deepEqual(parseYaml('a: !!str foo\n'), { a: 'foo' });
});

test('a double-quoted flow-sequence element decodes \\u escapes, same as a block scalar', () => {
  const doc = parseYaml('required: ["\\u0061"]') as { required: string[] };
  assert.deepEqual(doc.required, ['a']);
});

test('a trailing comma right before the closing bracket ends a flow sequence, not a null element', () => {
  const doc = parseYaml('required: [a,]') as { required: string[] };
  assert.deepEqual(doc.required, ['a']);
});

test('a trailing comma right before the closing brace ends a flow mapping', () => {
  const doc = parseYaml('obj: {x: 1,}') as { obj: { x: number } };
  assert.deepEqual(doc.obj, { x: 1 });
});

test('a second document is rejected rather than silently ignored', () => {
  assert.throws(() => parseYaml('a: 1\n---\nb: 2\n'), YamlParseError);
});

test('junk after the first document is rejected rather than silently ignored', () => {
  assert.throws(() => parseYaml('a: 1\nnot a valid continuation }\n'), YamlParseError);
});

test('a trailing `...` end-of-document marker is allowed', () => {
  const doc = parseYaml('a: 1\n...\n');
  assert.deepEqual(doc, { a: 1 });
});

test('a folded scalar keeps line breaks around a more-indented line', () => {
  const doc = parseYaml('x: >-\n  a\n    b\n  c\n') as { x: string };
  assert.equal(doc.x, 'a\n  b\nc');
});

test('a __proto__ key round-trips as an own property, in block and flow mappings', () => {
  const block = parseYaml('__proto__:\n  polluted: true\n') as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(block), Object.prototype);
  assert.ok(Object.prototype.hasOwnProperty.call(block, '__proto__'));
  assert.deepEqual(Object.getOwnPropertyDescriptor(block, '__proto__')?.value, { polluted: true });

  const flow = parseYaml('obj: {__proto__: 1}') as { obj: Record<string, unknown> };
  assert.ok(Object.prototype.hasOwnProperty.call(flow.obj, '__proto__'));
  assert.equal(Object.getOwnPropertyDescriptor(flow.obj, '__proto__')?.value, 1);
});

/*
 * The round-1 and round-2 review probes, run directly as their own
 * assertions (rather than only exercised indirectly through the tests
 * above), against the `yaml`-package-backed parser.
 */

test('probe: [!!str 1] resolves the explicit tag per the core schema, not as a refusal', () => {
  assert.deepEqual(parseYaml('[!!str 1]'), ['1']);
});

test('probe: [*p] — an alias with no matching anchor is still refused, not a resolution error', () => {
  assert.throws(() => parseYaml('[*p]'), YamlParseError);
});

test('probe: [&p 1] — an anchored flow-sequence element is refused even though it is never aliased', () => {
  assert.throws(() => parseYaml('[&p 1]'), YamlParseError);
});

test('probe: ["\\x61"] decodes the \\x escape to "a"', () => {
  assert.deepEqual(parseYaml(String.raw`["\x61"]`), ['a']);
});

test('probe: ">-\\n\\n  a" — a leading blank line in a strip-chomped folded scalar is preserved literally', () => {
  assert.equal(parseYaml('>-\n\n  a'), '\na');
});

test('probe: ["a"] is a one-element flow sequence of the plain string "a"', () => {
  assert.deepEqual(parseYaml(String.raw`["a"]`), ['a']);
});

test('probe: [a,] — a trailing comma still ends the flow sequence at one element', () => {
  assert.deepEqual(parseYaml('[a,]'), ['a']);
});

test('probe: a __proto__ block-mapping key parses as a plain own key, not a prototype mutation', () => {
  const doc = parseYaml('__proto__:\n  x: 1\n') as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(doc), Object.prototype);
  assert.deepEqual(Object.getOwnPropertyDescriptor(doc, '__proto__')?.value, { x: 1 });
});

test('probe: a trailing "---" document is rejected, not silently narrowed to the first', () => {
  assert.throws(() => parseYaml('a: 1\n---\nb: 2\n'), YamlParseError);
});
