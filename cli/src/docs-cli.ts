/**
 * `apibreak docs` — checks the API calls in hand-written docs against the
 * OpenAPI spec they describe.
 *
 * Generated reference docs follow the spec by construction. The guides,
 * READMEs, quickstarts and changelog examples written by hand do not: a field
 * is renamed, a path gains a version prefix, an operation is deprecated, and
 * the curl a customer copies from the quickstart stops working. This reads
 * those examples — fenced curl, raw HTTP, `fetch`, Python `requests`, and
 * inline `METHOD /path` prose — and reports each one the spec no longer
 * supports, with the file and line to fix.
 *
 * Deterministic and local: no model, no network beyond fetching the spec when
 * it is given as a URL, nothing uploaded.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { checkReferences, type DocsFinding, type IgnoredReference } from './docs-check.js';
import { scanMarkdown, type DocReference, type UnparsedReference } from './docs-extract.js';
import { expandGlobs } from './glob.js';
import { isUrl, loadSpec } from './load-spec.js';
import { escapeCell, pluralise } from './report.js';

export type DocsFailOn = 'error' | 'warning' | 'never';
const DOCS_FAIL_ON: readonly DocsFailOn[] = ['error', 'warning', 'never'];

export const DEFAULT_DOC_GLOBS = ['docs/**/*.{md,mdx}', 'README.md'];

export const DOCS_USAGE = `apibreak docs --spec <file|url> [--base-url <url>]... [--json <path>] [--summary <path>]
              [--fail-on error|warning|never] [files or globs...]

Checks the API calls in hand-written Markdown/MDX docs against an OpenAPI 3.x
or Swagger 2.0 spec: fenced curl, raw HTTP, fetch() and Python requests
examples, and inline "GET /v1/things/{id}" references. Reports endpoints the
spec does not have, wrong methods, body fields and query parameters the spec
does not list, required ones an example leaves out, and deprecated operations
and fields. No model, nothing uploaded.

Files default to ${DEFAULT_DOC_GLOBS.join(' and ')}. A URL on a host the spec's
servers do not name is skipped and counted; add --base-url (repeatable) for
the hosts your docs use, e.g. --base-url http://localhost:3000/api.
Mark a line or the next code block with <!-- apibreak-ignore -->, or a whole
file with <!-- apibreak-ignore-file -->.

The Markdown report goes to stdout; --json and --summary also write it to
files. Exit codes: 0 nothing at or above --fail-on (default error), 1 a
finding at or above it, 2 a usage error, an unreadable spec, or no files.`;

interface DocsOptions {
  spec: string;
  baseUrls: string[];
  jsonOut?: string;
  summaryOut?: string;
  failOn: DocsFailOn;
  patterns: string[];
}

export function parseDocsArgs(argv: string[]): DocsOptions | { error: string } {
  let spec: string | undefined;
  const baseUrls: string[] = [];
  let jsonOut: string | undefined;
  let summaryOut: string | undefined;
  let failOn: DocsFailOn = 'error';
  const patterns: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const value = (): string | undefined => (eq === -1 ? argv[++i] : arg.slice(eq + 1));
    switch (name) {
      case '--spec': {
        const v = value();
        if (!v) return { error: '--spec needs a file or URL' };
        spec = v;
        break;
      }
      case '--base-url': {
        const v = value();
        if (!v) return { error: '--base-url needs a URL' };
        if (!/^(?:https?:)?\/\//i.test(v) && !v.startsWith('/')) return { error: `--base-url "${v}" is not an http(s) URL or a /path prefix` };
        baseUrls.push(v);
        break;
      }
      case '--json': {
        const v = value();
        if (!v) return { error: '--json needs a path' };
        jsonOut = v;
        break;
      }
      case '--summary': {
        const v = value();
        if (!v) return { error: '--summary needs a path' };
        summaryOut = v;
        break;
      }
      case '--fail-on': {
        const v = value();
        if (!v || !DOCS_FAIL_ON.includes(v as DocsFailOn)) return { error: `--fail-on must be one of ${DOCS_FAIL_ON.join(', ')}` };
        failOn = v as DocsFailOn;
        break;
      }
      default:
        if (arg.startsWith('-')) return { error: `unknown argument "${arg}"` };
        patterns.push(arg);
    }
  }
  if (!spec) return { error: '--spec is required' };
  return { spec, baseUrls, failOn, patterns, ...(jsonOut ? { jsonOut } : {}), ...(summaryOut ? { summaryOut } : {}) };
}

export interface DocsReport {
  spec: string;
  specTitle?: string;
  specVersion?: string;
  generatedAt: string;
  counts: {
    filesScanned: number;
    references: number;
    parsed: number;
    unparsed: number;
    checked: number;
    ignoredOtherHost: number;
    suppressed: number;
    bodiesNotRead: number;
    queriesNotRead: number;
    errors: number;
    warnings: number;
  };
  findings: DocsFinding[];
  unparsed: UnparsedReference[];
  ignored: IgnoredReference[];
  /** Hosts skipped, most frequent first, with counts. */
  ignoredHosts: Array<{ host: string; count: number }>;
}

/** Pure: scanned files + a loaded spec → the report. */
export function buildDocsReport(
  specLabel: string,
  spec: Parameters<typeof checkReferences>[1],
  files: Array<{ path: string; text: string }>,
  baseUrls: string[],
  generatedAt: string
): DocsReport {
  const references: DocReference[] = [];
  const unparsed: UnparsedReference[] = [];
  let suppressed = 0;
  for (const f of files) {
    const scan = scanMarkdown(f.text, f.path);
    references.push(...scan.references);
    unparsed.push(...scan.unparsed);
    suppressed += scan.suppressed;
  }
  const checked = checkReferences(references, spec, { baseUrls });
  for (const u of checked.unresolved) {
    unparsed.push({ file: u.ref.file, line: u.ref.line, source: u.ref.source, snippet: u.ref.snippet, reason: u.reason });
  }
  unparsed.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));

  const hostCounts = new Map<string, number>();
  for (const i of checked.ignored) hostCounts.set(i.host, (hostCounts.get(i.host) ?? 0) + 1);
  const ignoredHosts = [...hostCounts.entries()]
    .map(([host, count]) => ({ host, count }))
    .sort((a, b) => b.count - a.count || a.host.localeCompare(b.host));

  const errors = checked.findings.filter((f) => f.severity === 'error').length;
  const parsed = references.length - checked.unresolved.length;
  const info = spec.raw?.info;
  return {
    spec: specLabel,
    ...(typeof info?.title === 'string' ? { specTitle: info.title } : {}),
    ...(spec.version ? { specVersion: spec.version } : {}),
    generatedAt,
    counts: {
      filesScanned: files.length,
      references: parsed + unparsed.length,
      parsed,
      unparsed: unparsed.length,
      checked: checked.checked,
      ignoredOtherHost: checked.ignored.length,
      suppressed,
      bodiesNotRead: checked.bodiesNotRead,
      queriesNotRead: checked.queriesNotRead,
      errors,
      warnings: checked.findings.length - errors,
    },
    findings: checked.findings,
    unparsed,
    ignored: checked.ignored,
    ignoredHosts,
  };
}

export function renderDocsJson(report: DocsReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

const code = (s: string): string => `\`${s.replace(/`/g, "'")}\``;

export function renderDocsMarkdown(report: DocsReport): string {
  const c = report.counts;
  const lines: string[] = [];
  lines.push('## apibreak docs');
  lines.push('');
  const head: string[] = [];
  if (c.errors > 0) head.push(`**${c.errors} ${pluralise(c.errors, 'error', 'errors')}**`);
  if (c.warnings > 0) head.push(`${c.warnings} ${pluralise(c.warnings, 'warning', 'warnings')}`);
  if (head.length === 0) head.push('no findings');
  const otherHost = c.ignoredOtherHost > 0 ? `, ${c.ignoredOtherHost} on other hosts` : '';
  lines.push(
    `${head.join(', ')} — ${c.filesScanned} ${pluralise(c.filesScanned, 'file', 'files')} scanned, ${c.references} API ${pluralise(
      c.references,
      'reference',
      'references'
    )} found: ${c.parsed} parsed (${c.checked} checked${otherHost}), ${c.unparsed} unparsed.`
  );
  lines.push('');
  const specName = [report.specTitle, report.specVersion].filter(Boolean).join(' ');
  lines.push(`Spec: ${code(report.spec)}${specName ? ` (${escapeCell(specName)})` : ''}`);
  lines.push('');

  if (report.findings.length === 0) {
    lines.push(
      c.checked === 0
        ? 'No reference was checked against the spec, so this run says nothing about the docs. See the counts above.'
        : 'Every checked reference matches an operation in the spec, with the method, fields and parameters it lists.'
    );
    lines.push('');
  } else {
    lines.push('### Findings');
    lines.push('');
    lines.push('| Severity | Where | Rule | Reference | Problem | Fix |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    const ordered = [...report.findings].sort(
      (a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1) || (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line)
    );
    for (const f of ordered) {
      lines.push(
        `| ${f.severity === 'error' ? '**error**' : 'warning'} | ${code(`${f.file}:${f.line}`)} | ${f.rule} | ${code(escapeCell(f.reference))} | ${escapeCell(
          f.detail
        )} | ${escapeCell(f.hint)} |`
      );
    }
    lines.push('');
  }

  if (report.unparsed.length > 0) {
    lines.push(`<details><summary>${report.unparsed.length} unparsed ${pluralise(report.unparsed.length, 'reference', 'references')} (not checked)</summary>`);
    lines.push('');
    for (const u of report.unparsed) lines.push(`- ${code(`${u.file}:${u.line}`)} ${u.source}: ${escapeCell(u.reason)}`);
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }
  if (report.ignoredHosts.length > 0) {
    const hosts = report.ignoredHosts.map((h) => `${code(h.host)} ×${h.count}`).join(', ');
    lines.push(`Skipped, host not in the spec's servers: ${hosts}. Pass \`--base-url\` for a host your docs use to check those too.`);
    lines.push('');
  }
  const notes: string[] = [];
  if (c.bodiesNotRead > 0) notes.push(`${c.bodiesNotRead} request ${pluralise(c.bodiesNotRead, 'body was', 'bodies were')} not read (a variable, a file, or not valid JSON), so ${pluralise(c.bodiesNotRead, 'its', 'their')} fields were not checked`);
  if (c.queriesNotRead > 0) notes.push(`${c.queriesNotRead} query ${pluralise(c.queriesNotRead, 'string was', 'strings were')} not fully read (a variable stood in for a parameter), so ${pluralise(c.queriesNotRead, 'its', 'their')} query parameters were not checked`);
  if (c.suppressed > 0) notes.push(`${c.suppressed} ${pluralise(c.suppressed, 'reference', 'references')} skipped by an apibreak-ignore marker`);
  if (notes.length > 0) {
    lines.push(`${notes.join('; ')}.`);
    lines.push('');
  }
  lines.push(
    'Only fenced curl, HTTP, fetch() and Python requests/httpx examples and inline METHOD /path references are read; other languages and SDK calls are not checked. Body fields and query parameters are checked at the top level only.'
  );
  lines.push('');
  return lines.join('\n');
}

export function docsExitCode(report: DocsReport, failOn: DocsFailOn): number {
  if (failOn === 'never') return 0;
  if (failOn === 'warning') return report.findings.length > 0 ? 1 : 0;
  return report.counts.errors > 0 ? 1 : 0;
}

export interface DocsDeps {
  fetch: typeof fetch;
  now: () => Date;
  cwd: string;
}

export interface Writer {
  write: (s: string) => void;
}

export async function runDocs(argv: string[], deps: DocsDeps, out: Writer, err: Writer): Promise<number> {
  const opts = parseDocsArgs(argv);
  if ('error' in opts) {
    err.write(`${opts.error}\n\n${DOCS_USAGE}\n`);
    return 2;
  }

  const specSource = isUrl(opts.spec) || isAbsolute(opts.spec) ? opts.spec : join(deps.cwd, opts.spec);
  const loaded = await loadSpec(specSource, deps.fetch);
  if (!loaded.ok) {
    err.write(`${opts.spec}: ${loaded.error}\n`);
    return 2;
  }
  if (loaded.doc.unreadable) {
    err.write(`${opts.spec}: ${loaded.doc.unreadable}\n`);
    return 2;
  }

  const usingDefaults = opts.patterns.length === 0;
  const { files, unmatched } = await expandGlobs(usingDefaults ? DEFAULT_DOC_GLOBS : opts.patterns, deps.cwd);
  if (!usingDefaults) for (const u of unmatched) err.write(`warning: ${u} matched no files\n`);
  if (files.length === 0) {
    err.write(
      usingDefaults
        ? `no docs found: nothing matched ${DEFAULT_DOC_GLOBS.join(' or ')}; pass the files or globs to check\n`
        : 'no files matched; nothing was checked\n'
    );
    return 2;
  }

  const texts: Array<{ path: string; text: string }> = [];
  for (const path of files) {
    try {
      texts.push({ path, text: await readFile(isAbsolute(path) ? path : join(deps.cwd, path), 'utf8') });
    } catch (e) {
      err.write(`cannot read ${path}: ${(e as Error).message}\n`);
      return 2;
    }
  }

  const report = buildDocsReport(opts.spec, loaded.doc, texts, opts.baseUrls, deps.now().toISOString());
  const markdown = renderDocsMarkdown(report);
  out.write(`${markdown}\n`);
  // A write failure here (e.g. the parent directory of --json/--summary does
  // not exist) is a usage error, not a docs finding — it must not surface as
  // an uncaught rejection (exit 1, indistinguishable from "a finding was at
  // or above --fail-on") or silently swallow the report the run just spent
  // time producing.
  if (opts.jsonOut) {
    const dest = isAbsolute(opts.jsonOut) ? opts.jsonOut : join(deps.cwd, opts.jsonOut);
    try {
      await writeFile(dest, renderDocsJson(report), 'utf8');
    } catch (e) {
      err.write(`cannot write ${opts.jsonOut}: ${(e as Error).message}\n`);
      return 2;
    }
  }
  if (opts.summaryOut) {
    const dest = isAbsolute(opts.summaryOut) ? opts.summaryOut : join(deps.cwd, opts.summaryOut);
    try {
      await writeFile(dest, markdown, 'utf8');
    } catch (e) {
      err.write(`cannot write ${opts.summaryOut}: ${(e as Error).message}\n`);
      return 2;
    }
  }
  return docsExitCode(report, opts.failOn);
}
