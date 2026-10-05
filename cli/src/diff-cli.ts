/**
 * `apibreak diff <old> <new>` — the general-purpose sibling of `check`.
 *
 * `check` compares a vendor's own published specification against itself over
 * time, filtered to the endpoints a customer declared in `apibreak.json`.
 * `diff` compares any two OpenAPI/Swagger documents — local files or URLs,
 * JSON or YAML — with no manifest and no registry entry, which is what makes
 * it usable on an owner's own repository: `apibreak diff --base-ref
 * origin/main openapi.yaml` in a pull request, or `apibreak diff old.yaml
 * new.yaml` comparing two releases by hand.
 *
 * Every endpoint present in either document is compared — the union, not an
 * intersection — so an operation that only exists in the new spec is a
 * (non-breaking) addition and one that only exists in the old spec is a
 * removal, exactly as `diffEndpoints` already reports both cases for a
 * customer's declared endpoints.
 */

import { isAbsolute, join } from 'node:path';
import { diffEndpoints } from './diff.js';
import { docFromText, readSpecText, readSpecTextAtGitRef } from './load-spec.js';
import { alignPaths } from './match-endpoints.js';
import { escapeCell, pluralise, summarise, sortFindings } from './report.js';
import { indexSpec } from './spec.js';
import type { EndpointRef, Finding, Method, RunReport } from './types.js';

export type DiffFailOn = 'breaking' | 'any' | 'none';
const DIFF_FAIL_ON: readonly DiffFailOn[] = ['breaking', 'any', 'none'];

export const DIFF_USAGE = `apibreak diff <old> <new> [--json] [--fail-on breaking|any|none]
apibreak diff --base-ref <git-ref> <path> [--json] [--fail-on breaking|any|none]

Compares two OpenAPI 3.x or Swagger 2.0 documents — local files or http(s)
URLs, JSON or YAML — and reports every change to every endpoint present in
either one. Unlike \`check\`, no apibreak.json is read and no vendor registry
is consulted: this works on any specification, including your own.

With --base-ref, <path> is a file in the working tree, compared against the
same path read from <git-ref> with \`git show\`. Run it from inside the
repository.

Exit codes: 0 clean (or nothing at or above --fail-on), 1 a finding at or
above --fail-on, 2 a usage error or a document that could not be fetched or
parsed. --fail-on breaking (the default) fails only on breaking findings;
--fail-on any also fails on deprecations, unknowns and advisories, but never
on "not compared" — a standing limit of the comparison, identical on every
run, not a change; --fail-on none always exits 0.`;

interface DiffOptionsBase {
  json: boolean;
  failOn: DiffFailOn;
}
type DiffOptions =
  | (DiffOptionsBase & { mode: 'pair'; oldSource: string; newSource: string })
  | (DiffOptionsBase & { mode: 'base-ref'; baseRef: string; path: string });

export function parseDiffArgs(argv: string[]): DiffOptions | { error: string } {
  let json = false;
  let failOn: DiffFailOn = 'breaking';
  let baseRef: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const next = (): string | undefined => argv[++i];
    switch (arg) {
      case '--json':
        json = true;
        break;
      case '--fail-on': {
        const v = next();
        if (!v || !DIFF_FAIL_ON.includes(v as DiffFailOn)) {
          return { error: `--fail-on must be one of ${DIFF_FAIL_ON.join(', ')}` };
        }
        failOn = v as DiffFailOn;
        break;
      }
      case '--base-ref': {
        const v = next();
        if (!v) return { error: '--base-ref needs a git ref' };
        baseRef = v;
        break;
      }
      default:
        if (arg.startsWith('--')) return { error: `unknown argument "${arg}"` };
        positional.push(arg);
    }
  }

  if (baseRef !== undefined) {
    if (positional.length !== 1) return { error: '--base-ref takes exactly one argument: <path>' };
    const path = positional[0];
    if (path === undefined) return { error: '--base-ref takes exactly one argument: <path>' };
    return { json, failOn, mode: 'base-ref', baseRef, path };
  }
  if (positional.length !== 2) return { error: 'diff needs exactly two arguments: <old> <new>' };
  const [oldSource, newSource] = positional;
  if (oldSource === undefined || newSource === undefined) {
    return { error: 'diff needs exactly two arguments: <old> <new>' };
  }
  return { json, failOn, mode: 'pair', oldSource, newSource };
}

export interface DiffReport extends RunReport {
  old: string;
  new: string;
}

function unionEndpoints(
  a: ReadonlyMap<string, unknown>,
  b: ReadonlyMap<string, unknown>
): EndpointRef[] {
  const keys = new Set<string>([...a.keys(), ...b.keys()]);
  const endpoints: EndpointRef[] = [];
  for (const key of keys) {
    const sp = key.indexOf(' ');
    if (sp === -1) continue;
    endpoints.push({ method: key.slice(0, sp) as Method, path: key.slice(sp + 1) });
  }
  endpoints.sort((x, y) => (x.method === y.method ? x.path.localeCompare(y.path) : x.method.localeCompare(y.method)));
  return endpoints;
}

/**
 * Two path templates that name the same wire URL are paired before
 * comparison — a placeholder rename, a trailing slash, or the prefix moving
 * between `servers[]`/`basePath` and the path templates (see
 * match-endpoints.ts) — so the two operations are actually diffed against
 * each other and a cosmetic spec edit is never reported as a removal. `check`
 * does not go through this path: it compares a vendor's own document against
 * itself over time, filtered to a customer's declared endpoints, and is
 * unaffected.
 *
 * `diff` compares the *union* of both documents' endpoints (see
 * `unionEndpoints`), so every `endpoint_not_in_baseline` finding
 * `diffEndpoints` produces here is, by construction, an operation that only
 * the new document declares — `check`'s manifest-driven "declared but not in
 * either spec" case cannot occur. Such an operation is a plain addition, not
 * an unknown: it is counted as an additive change instead of being emitted as
 * a finding, exactly as `check` already counts any other addition. Human and
 * `--json` output are built from the same `findings`/`additiveChanges` here,
 * so they necessarily agree.
 */
export function buildDiffReport(
  oldLabel: string,
  newLabel: string,
  oldDoc: Parameters<typeof diffEndpoints>[0]['baseline'],
  newDoc: Parameters<typeof diffEndpoints>[0]['current'],
  generatedAt: string
): DiffReport {
  const { doc: alignedNewRaw, ambiguous, serverChanged, possiblyMoved, rootPrefixChanged } = alignPaths(
    oldDoc.raw,
    newDoc.raw
  );
  // `alignPaths` re-keys `paths` under the old document's templates so the
  // engine pairs the same operation instead of reporting a placeholder
  // rename as a removal-plus-addition. That re-keying is for PAIRING only: a
  // `$ref` the vendor wrote into `#/paths/<their own literal path text>/...`
  // is ordinary, and resolves fine against the document as the vendor wrote
  // it. Indexing the RE-KEYED document (`indexSpec(alignedNewRaw)` on its
  // own) would also make it the resolution root for every `deref` call
  // downstream, and a `$ref` like that would no longer find its target — the
  // key it points at was renamed to the old document's spelling. The engine
  // needs the aligned document's `operations`/`paths` (so pairing happens),
  // but must resolve every `$ref` against the document the vendor actually
  // published.
  const alignedNewDoc =
    alignedNewRaw === newDoc.raw ? newDoc : { ...indexSpec(alignedNewRaw), raw: newDoc.raw };
  const endpoints = unionEndpoints(oldDoc.operations, alignedNewDoc.operations);
  const result = diffEndpoints({
    vendor: 'diff',
    baseline: oldDoc,
    current: alignedNewDoc,
    endpoints,
    ambiguous,
    serverChanged,
    possiblyMoved,
  });

  const findings: Finding[] = [];
  if (rootPrefixChanged) {
    // One finding for the whole document: the root server path is not a
    // property of any single operation, and repeating it per operation would
    // bury whatever actually changed inside them. `unknown`, like the
    // per-operation `server_changed`: whether a caller's URLs moved depends on
    // how that caller sets its base URL, which neither document says.
    const fmt = (p: string): string => (p === '' ? '(none)' : `"${p}"`);
    findings.push({
      kind: 'server_changed',
      severity: 'unknown',
      vendor: 'diff',
      endpoint: 'servers',
      detail: `the root server path changed from ${fmt(rootPrefixChanged.from)} to ${fmt(rootPrefixChanged.to)}, so every operation's URL path changed with it; ${rootPrefixChanged.paired} path ${pluralise(rootPrefixChanged.paired, 'template', 'templates')} unchanged between the two documents ${pluralise(rootPrefixChanged.paired, 'was', 'were')} paired by template and compared`,
    });
  }
  let additiveChanges = result.additiveChanges;
  let endpointsChecked = result.endpointsChecked;
  let endpointsSkipped = result.endpointsSkipped;
  for (const f of result.findings) {
    if (f.kind === 'endpoint_not_in_baseline') {
      additiveChanges += 1;
      endpointsChecked += 1;
      endpointsSkipped -= 1;
      continue;
    }
    findings.push(f);
  }

  return {
    old: oldLabel,
    new: newLabel,
    generatedAt,
    findings,
    endpointsChecked,
    endpointsSkipped,
    additiveChanges,
    sources: [],
  };
}

export function renderDiffJson(report: DiffReport): string {
  const counts = summarise(report);
  return `${JSON.stringify(
    {
      old: report.old,
      new: report.new,
      generatedAt: report.generatedAt,
      endpointsChecked: report.endpointsChecked,
      endpointsSkipped: report.endpointsSkipped,
      additiveChanges: report.additiveChanges,
      counts,
      findings: sortFindings(report.findings),
    },
    null,
    2
  )}\n`;
}

/**
 * Breaking changes first, as a list — the same wording `diffEndpoints`
 * already produces — then everything else as counts only. A full table of
 * every advisory and "not compared" finding is what `--json` is for; the
 * human summary's job is to answer "did anything break", not to reproduce
 * the whole report.
 */
export function renderDiffMarkdown(report: DiffReport): string {
  const counts = summarise(report);
  const lines: string[] = [];

  lines.push('## apibreak diff');
  lines.push('');
  lines.push(`\`${report.old}\` → \`${report.new}\``);
  lines.push('');

  const breaking = sortFindings(report.findings).filter((f) => f.severity === 'breaking');
  if (breaking.length === 0) {
    lines.push('No breaking changes to any endpoint in either specification.');
  } else {
    lines.push(`### Breaking changes (${breaking.length})`);
    lines.push('');
    lines.push('| Endpoint | What changed |');
    lines.push('| --- | --- |');
    for (const finding of breaking) {
      const whatChanged = finding.at ? `\`${finding.at}\` — ${finding.detail}` : finding.detail;
      lines.push(`| \`${escapeCell(finding.endpoint)}\` | ${escapeCell(whatChanged)} |`);
    }
  }
  lines.push('');

  const otherParts: string[] = [];
  if (counts.deprecation > 0) otherParts.push(`${counts.deprecation} ${pluralise(counts.deprecation, 'deprecation', 'deprecations')}`);
  if (counts.unknown > 0) otherParts.push(`${counts.unknown} unknown`);
  if (counts.advisory > 0) otherParts.push(`${counts.advisory} advisory`);
  if (counts.notCompared > 0) otherParts.push(`${counts.notCompared} not compared`);
  const skippedClause = report.endpointsSkipped === 0 ? '' : `, ${report.endpointsSkipped} skipped`;

  lines.push(
    `${otherParts.length > 0 ? otherParts.join(', ') : 'no other findings'} — ${report.endpointsChecked} ${pluralise(
      report.endpointsChecked,
      'endpoint',
      'endpoints'
    )} checked${skippedClause}, ${report.additiveChanges} ${pluralise(
      report.additiveChanges,
      'additive change',
      'additive changes'
    )} not listed.`
  );
  lines.push('');

  return lines.join('\n');
}

/**
 * `breaking` (the default) fails only on a breaking finding. `any` fails on
 * anything that changed — breaking, deprecation, unknown or advisory — but
 * never on `not_compared`, which is a standing limit of the comparison
 * (an anyOf/oneOf union, a depth limit) rather than something that changed
 * between the two documents; it reads the same on every run against the same
 * pair of specs, so failing on it would make `--fail-on any` permanently red
 * against any real specification that uses unions, which is most of them.
 * `none` never fails.
 */
export function diffExitCode(findings: Finding[], failOn: DiffFailOn): number {
  if (failOn === 'none') return 0;
  if (failOn === 'breaking') return findings.some((f) => f.severity === 'breaking') ? 1 : 0;
  return findings.some((f) => f.severity !== 'not_compared') ? 1 : 0;
}

export interface DiffDeps {
  fetch: typeof fetch;
  now: () => Date;
  cwd: string;
}

export interface Writer {
  write: (s: string) => void;
}

export async function runDiff(argv: string[], deps: DiffDeps, out: Writer, err: Writer): Promise<number> {
  const opts = parseDiffArgs(argv);
  if ('error' in opts) {
    err.write(`${opts.error}\n\n${DIFF_USAGE}\n`);
    return 2;
  }

  let oldLabel: string;
  let newLabel: string;
  let oldText: Awaited<ReturnType<typeof readSpecText>>;
  let newText: Awaited<ReturnType<typeof readSpecText>>;

  if (opts.mode === 'base-ref') {
    oldLabel = `${opts.baseRef}:${opts.path}`;
    newLabel = opts.path;
    const workingTreePath = isAbsolute(opts.path) ? opts.path : join(deps.cwd, opts.path);
    [oldText, newText] = await Promise.all([
      readSpecTextAtGitRef(opts.baseRef, workingTreePath, deps.cwd),
      readSpecText(workingTreePath, deps.fetch),
    ]);
  } else {
    oldLabel = opts.oldSource;
    newLabel = opts.newSource;
    [oldText, newText] = await Promise.all([
      readSpecText(opts.oldSource, deps.fetch),
      readSpecText(opts.newSource, deps.fetch),
    ]);
  }

  if (!oldText.ok) {
    err.write(`${oldLabel}: ${oldText.error}\n`);
    return 2;
  }
  if (!newText.ok) {
    err.write(`${newLabel}: ${newText.error}\n`);
    return 2;
  }

  const oldDoc = docFromText(oldLabel, oldText.text);
  if (!oldDoc.ok) {
    err.write(`${oldDoc.error}\n`);
    return 2;
  }
  const newDoc = docFromText(newLabel, newText.text);
  if (!newDoc.ok) {
    err.write(`${newDoc.error}\n`);
    return 2;
  }
  if (oldDoc.doc.unreadable) {
    err.write(`${oldLabel}: ${oldDoc.doc.unreadable}\n`);
    return 2;
  }
  if (newDoc.doc.unreadable) {
    err.write(`${newLabel}: ${newDoc.doc.unreadable}\n`);
    return 2;
  }

  const report = buildDiffReport(oldLabel, newLabel, oldDoc.doc, newDoc.doc, deps.now().toISOString());
  out.write(opts.json ? renderDiffJson(report) : renderDiffMarkdown(report));
  return diffExitCode(report.findings, opts.failOn);
}
