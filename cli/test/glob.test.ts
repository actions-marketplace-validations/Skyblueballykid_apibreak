/**
 * `glob.ts`'s own matcher and its handling of absolute paths/patterns — split
 * out from `docs-check.test.ts` (which still covers the ordinary relative
 * cases) because both of these concern the matcher's own correctness rather
 * than how `apibreak docs` uses it.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandGlobs, globToRegExp } from '../src/glob.js';

test('globToRegExp: a pattern built from many *-runs resolves quickly instead of backtracking exponentially', () => {
  // The textbook catastrophic-backtracking shape for a regex-based matcher:
  // `^(?:[^/]*a){24}b$` against a long run of `a`s with no trailing `b` makes
  // the engine retry every split of every `*` before giving up.
  const pattern = `${'*a'.repeat(24)}b`;
  const text = `${'a'.repeat(48)}.md`;
  const start = Date.now();
  const matched = globToRegExp(pattern).test(text);
  assert.ok(Date.now() - start < 100, 'a non-backtracking matcher must resolve this well under 100ms');
  assert.equal(matched, false);
});

test('globToRegExp: ** still matches zero or more whole path segments, * stays within one segment', () => {
  assert.ok(globToRegExp('docs/**/*.md').test('docs/a.md'));
  assert.ok(globToRegExp('docs/**/*.md').test('docs/x/y/a.md'));
  assert.ok(!globToRegExp('docs/*.md').test('docs/x/a.md'));
});

test('expandGlobs: an absolute literal path or glob pattern is resolved as given, not joined under cwd', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'apibreak-glob-cwd-'));
  const other = mkdtempSync(join(tmpdir(), 'apibreak-glob-other-'));
  mkdirSync(join(other, 'docs'), { recursive: true });
  writeFileSync(join(other, 'docs', 'guide.md'), 'x');

  // Before the fix, `join(cwd, '/abs/path')` silently produced `cwd/abs/path`
  // — a file that does not exist — so these patterns matched nothing.
  const literal = await expandGlobs([join(other, 'docs', 'guide.md')], cwd);
  assert.equal(literal.unmatched.length, 0, 'an absolute literal path must not be reported as unmatched');
  assert.equal(literal.files.length, 1);
  const literalFull = isAbsolute(literal.files[0]!) ? literal.files[0]! : join(cwd, literal.files[0]!);
  assert.equal(readFileSync(literalFull, 'utf8'), 'x');

  const glob = await expandGlobs([join(other, 'docs', '*.md')], cwd);
  assert.equal(glob.unmatched.length, 0, 'an absolute glob pattern must not be reported as unmatched');
  assert.equal(glob.files.length, 1);
  const globFull = isAbsolute(glob.files[0]!) ? glob.files[0]! : join(cwd, glob.files[0]!);
  assert.equal(readFileSync(globFull, 'utf8'), 'x');
});
