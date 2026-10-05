/**
 * Just enough globbing for `apibreak docs <files or globs...>`: `**`, `*`,
 * `?` and `{a,b}`. Node 20 (the package's floor) has no `fs.glob`, and the
 * published bundle carries no dependencies, so this is first-party.
 *
 * A directory argument means every Markdown/MDX file under it. Walks skip
 * `node_modules` and dot-directories unless the pattern names them itself.
 */

import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

const GLOB_CHARS = /[*?{[]/;
const MARKDOWN = /\.(?:md|mdx|markdown)$/i;

/** `a/{b,c}/*.{md,mdx}` → every combination. */
export function expandBraces(pattern: string): string[] {
  const m = /\{([^{}]*)\}/.exec(pattern);
  if (!m) return [pattern];
  const head = pattern.slice(0, m.index);
  const tail = pattern.slice(m.index + m[0].length);
  return m[1]!.split(',').flatMap((alt) => expandBraces(`${head}${alt}${tail}`));
}

/**
 * `*` and `?` within ONE path segment, matched with the classic two-pointer
 * wildcard algorithm (bookmark the last `*` and the text position it
 * started at; on a mismatch, retry from one character further in rather
 * than re-deriving a whole new backtracking branch). Worst case is a bounded
 * O(pattern × text) scan, so a pattern built from many `*` runs (`'*a'`
 * repeated dozens of times) cannot blow up the way the regex it replaces
 * could: `^(?:[^/]*a){24}b$` against a long run of `a`s is the textbook
 * catastrophic-backtracking shape.
 */
function matchSegment(pattern: string, text: string): boolean {
  let pi = 0;
  let ti = 0;
  let starAt = -1;
  let starText = 0;
  while (ti < text.length) {
    const p = pattern[pi];
    if (p === '?' || (p !== undefined && p === text[ti])) {
      pi += 1;
      ti += 1;
    } else if (p === '*') {
      starAt = pi;
      starText = ti;
      pi += 1;
    } else if (starAt !== -1) {
      pi = starAt + 1;
      starText += 1;
      ti = starText;
    } else {
      return false;
    }
  }
  while (pattern[pi] === '*') pi += 1;
  return pi === pattern.length;
}

export interface GlobMatcher {
  /** Does `path` (a `/`-separated relative or absolute path) match? */
  test(path: string): boolean;
}

/**
 * One brace-free glob → a matcher over `/`-separated paths. `**` is special
 * only as a WHOLE path segment (the usual convention, and the only way this
 * module's own patterns ever use it): it stands for zero or more entire
 * segments, matched with a small memoised search so more than one `**` in a
 * pattern stays polynomial rather than exploring every split again for every
 * segment it already ruled out. Every other segment — `**` embedded in a
 * larger one included — is matched one-to-one against a path segment with
 * `matchSegment`, which is itself immune to the catastrophic-backtracking
 * failure a regex-based matcher had.
 */
export function globToRegExp(pattern: string): GlobMatcher {
  const patSegs = pattern.split('/');
  return {
    test(path: string): boolean {
      const pathSegs = path.split('/');
      const memo = new Map<number, Map<number, boolean>>();
      const rec = (pi: number, si: number): boolean => {
        let row = memo.get(pi);
        const cached = row?.get(si);
        if (cached !== undefined) return cached;
        let result: boolean;
        if (pi === patSegs.length) {
          result = si === pathSegs.length;
        } else if (patSegs[pi] === '**') {
          result = rec(pi + 1, si) || (si < pathSegs.length && rec(pi, si + 1));
        } else {
          result = si < pathSegs.length && matchSegment(patSegs[pi]!, pathSegs[si]!) && rec(pi + 1, si + 1);
        }
        if (!row) {
          row = new Map();
          memo.set(pi, row);
        }
        row.set(si, result);
        return result;
      };
      return rec(0, 0);
    },
  };
}

async function walk(dir: string, allowHidden: boolean, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || (!allowHidden && e.name.startsWith('.'))) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(full, allowHidden, out);
    else if (e.isFile()) out.push(full);
  }
}

const toPosix = (p: string): string => p.split(sep).join('/');

/**
 * Files matching any of `patterns`, relative to `cwd`, sorted, de-duplicated.
 * `unmatched` lists the patterns that matched nothing, for the caller to
 * report — a pattern that silently matches nothing is how a docs check ends
 * up scanning zero files and passing.
 */
export async function expandGlobs(patterns: string[], cwd: string): Promise<{ files: string[]; unmatched: string[] }> {
  const files = new Set<string>();
  const unmatched: string[] = [];
  for (const original of patterns) {
    let hit = false;
    for (const pattern of expandBraces(original.replace(/^\.\//, ''))) {
      // An absolute path or pattern (`/tmp/docs.md`, `/tmp/*.md`) is resolved
      // as given, never joined under `cwd` — `join(cwd, '/tmp/x')` would
      // produce `cwd/tmp/x`, a file that does not exist. The path put into
      // `files` tracks this the same way: relative to `cwd` for a relative
      // pattern (so a caller's own `join(cwd, path)` finds it), absolute for
      // an absolute one (so it still finds it without double-prefixing).
      const abs = isAbsolute(pattern);
      const asResult = (f: string): string => toPosix(abs ? f : relative(cwd, f));
      if (!GLOB_CHARS.test(pattern)) {
        const full = abs ? pattern : join(cwd, pattern);
        const st = await stat(full).catch(() => null);
        if (st?.isFile()) {
          files.add(asResult(full));
          hit = true;
        } else if (st?.isDirectory()) {
          const found: string[] = [];
          await walk(full, false, found);
          for (const f of found) {
            if (MARKDOWN.test(f)) {
              files.add(asResult(f));
              hit = true;
            }
          }
        }
        continue;
      }
      const segments = pattern.split('/');
      const firstGlob = segments.findIndex((s) => GLOB_CHARS.test(s));
      const base = segments.slice(0, firstGlob).join('/');
      const baseFull = abs ? base : join(cwd, base);
      const re = globToRegExp(pattern);
      const found: string[] = [];
      await walk(baseFull, /(^|\/)\./.test(pattern.slice(base.length)), found);
      for (const f of found) {
        const matchAgainst = toPosix(abs ? f : relative(cwd, f));
        if (re.test(matchAgainst)) {
          files.add(matchAgainst);
          hit = true;
        }
      }
    }
    if (!hit) unmatched.push(original);
  }
  return { files: [...files].sort(), unmatched };
}
