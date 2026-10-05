import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exitCode, renderJson, renderMarkdown, sortFindings, summarise } from '../src/report.js';
import type { Finding, RunReport, SpecStamp, SourcePair } from '../src/types.js';

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    kind: 'operation_removed',
    severity: 'breaking',
    vendor: 'stripe',
    endpoint: 'POST /v1/charges',
    detail: 'Operation was removed',
    ...overrides,
  };
}

function makeSource(overrides: Partial<SourcePair> = {}): SourcePair {
  return {
    vendor: 'stripe',
    specUrl: 'https://example.com/openapi.yaml',
    baseline: { commit: 'abc1234def', version: '1.0.0' },
    current: { commit: 'def5678abc', version: '1.1.0' },
    fetchedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeReport(overrides: Partial<RunReport> = {}): RunReport {
  return {
    generatedAt: '2024-01-01T00:00:00Z',
    sources: [makeSource()],
    endpointsChecked: 1,
    endpointsSkipped: 0,
    additiveChanges: 0,
    findings: [],
    ...overrides,
  };
}

test('sortFindings puts breaking before deprecation and does not mutate the input', () => {
  const deprecation = makeFinding({ severity: 'deprecation', vendor: 'stripe' });
  const breaking = makeFinding({ severity: 'breaking', vendor: 'stripe' });
  const input = [deprecation, breaking];
  const sorted = sortFindings(input);
  assert.equal(sorted[0], breaking);
  assert.equal(sorted[1], deprecation);
  assert.equal(input[0], deprecation);
  assert.equal(input[1], breaking);
});

test('sortFindings orders equal-severity findings by vendor then endpoint', () => {
  const bStripe = makeFinding({ severity: 'advisory', vendor: 'stripe', endpoint: 'POST /v1/z' });
  const aStripe = makeFinding({ severity: 'advisory', vendor: 'stripe', endpoint: 'POST /v1/a' });
  const aTwilio = makeFinding({ severity: 'advisory', vendor: 'twilio', endpoint: 'POST /v1/m' });
  const sorted = sortFindings([bStripe, aStripe, aTwilio]);
  // Ascending on both keys: stripe before twilio, and /v1/a before /v1/z.
  assert.deepEqual(sorted, [aStripe, bStripe, aTwilio]);
});

test('summarise counts each severity and the total', () => {
  const report = makeReport({
    findings: [
      makeFinding({ severity: 'breaking' }),
      makeFinding({ severity: 'deprecation' }),
      makeFinding({ severity: 'unknown' }),
      makeFinding({ severity: 'advisory' }),
      makeFinding({ severity: 'not_compared' }),
      makeFinding({ severity: 'breaking' }),
    ],
  });
  assert.deepEqual(summarise(report), {
    breaking: 2,
    deprecation: 1,
    unknown: 1,
    advisory: 1,
    notCompared: 1,
    total: 6,
  });
});

test('renderJson ends with a newline, sorted findings, and leaves the input untouched', () => {
  const findings = [
    makeFinding({ severity: 'deprecation', vendor: 'stripe' }),
    makeFinding({ severity: 'breaking', vendor: 'stripe' }),
  ];
  const report = makeReport({ findings });
  const json = renderJson(report);
  assert.ok(json.endsWith('\n'));
  const parsed = JSON.parse(json) as RunReport;
  assert.equal(parsed.findings[0]?.severity, 'breaking');
  assert.equal(parsed.findings[1]?.severity, 'deprecation');
  assert.equal(report.findings[0]?.severity, 'deprecation');
  assert.equal(report.findings[1]?.severity, 'breaking');
});

// PROTECTS: a clean result must always show what was compared.
test('renderMarkdown on a clean report states no change and still lists sources', () => {
  const markdown = renderMarkdown(makeReport({ findings: [] }));
  assert.match(
    markdown,
    /No breaking or deprecating change to the endpoints you declared, and nothing this check could not read\./,
  );
  assert.match(markdown, /### Sources/);
});

test('renderMarkdown always states the scope: unknown fails the run, not compared never does', () => {
  const markdown = renderMarkdown(makeReport({ findings: [] }));
  assert.match(markdown, /Only the endpoints in your apibreak\.json were compared\./);
  assert.match(markdown, /listed as unknown and fails the run/);
  assert.match(markdown, /listed as not compared, on every run, and never fails one/);
});

test('renderMarkdown bolds breaking severity and backticks the endpoint', () => {
  const markdown = renderMarkdown(
    makeReport({ findings: [makeFinding({ severity: 'breaking', endpoint: 'POST /v1/charges' })] }),
  );
  assert.match(markdown, /\*\*breaking\*\*/);
  assert.match(markdown, /`POST \/v1\/charges`/);
});

test('renderMarkdown escapes a pipe inside a finding detail', () => {
  const markdown = renderMarkdown(
    makeReport({ findings: [makeFinding({ detail: 'field a | b removed' })] }),
  );
  assert.match(markdown, /field a \\| b removed/);
});

test('renderMarkdown mentions skipped endpoints only when there are any', () => {
  const clean = renderMarkdown(makeReport({ endpointsSkipped: 0 }));
  assert.ok(!clean.includes('skipped'));
  const skipped = renderMarkdown(makeReport({ endpointsSkipped: 2 }));
  assert.match(skipped, /2 skipped/);
});

test('renderMarkdown renders a source stamp with the seven-character commit prefix and version', () => {
  const source = makeSource({ baseline: { commit: 'abc1234def5678', version: '2.3.4' } });
  const markdown = renderMarkdown(makeReport({ sources: [source] }));
  assert.match(markdown, /commit@abc1234/);
  assert.match(markdown, /2\.3\.4/);
});

test('a source pair with an empty baseline stamp renders as unknown revision', () => {
  const source = makeSource({ baseline: {} as SpecStamp });
  const markdown = renderMarkdown(makeReport({ sources: [source] }));
  assert.match(markdown, /baseline unknown revision/);
});

test("exitCode with failOn 'breaking' is 2 for breaking, 0 for deprecation-only", () => {
  assert.equal(exitCode(makeReport({ findings: [makeFinding({ severity: 'breaking' })] }), 'breaking'), 2);
  assert.equal(exitCode(makeReport({ findings: [makeFinding({ severity: 'deprecation' })] }), 'breaking'), 0);
});

test("exitCode with failOn 'deprecation' is 2 for a deprecation-only report", () => {
  assert.equal(exitCode(makeReport({ findings: [makeFinding({ severity: 'deprecation' })] }), 'deprecation'), 2);
});

test("exitCode with failOn 'unknown' is 2 for an unknown-only report", () => {
  assert.equal(exitCode(makeReport({ findings: [makeFinding({ severity: 'unknown' })] }), 'unknown'), 2);
});

test("exitCode with failOn 'never' is 0 even with a breaking finding", () => {
  assert.equal(exitCode(makeReport({ findings: [makeFinding({ severity: 'breaking' })] }), 'never'), 0);
});

test('exitCode ignores an advisory finding at every threshold', () => {
  const report = makeReport({ findings: [makeFinding({ severity: 'advisory' })] });
  assert.equal(exitCode(report, 'breaking'), 0);
  assert.equal(exitCode(report, 'deprecation'), 0);
  assert.equal(exitCode(report, 'unknown'), 0);
  assert.equal(exitCode(report, 'never'), 0);
});

// The two cases the CI wiring depends on, pinned because they are deliberate
// rather than incidental: `unknown` means the check did not run, so it fails at
// every threshold that fails at all (run.ts turns an unreachable spec into one),
// while `not_compared` is a standing limit of the comparison and never fails.
test("exitCode fails an unknown-only report at every threshold except 'never'", () => {
  const report = makeReport({ findings: [makeFinding({ severity: 'unknown' })] });
  assert.equal(exitCode(report, 'breaking'), 2);
  assert.equal(exitCode(report, 'deprecation'), 2);
  assert.equal(exitCode(report, 'unknown'), 2);
  assert.equal(exitCode(report, 'never'), 0);
});

test('exitCode never fails a not_compared-only report at any threshold', () => {
  const report = makeReport({ findings: [makeFinding({ severity: 'not_compared' })] });
  assert.equal(exitCode(report, 'breaking'), 0);
  assert.equal(exitCode(report, 'deprecation'), 0);
  assert.equal(exitCode(report, 'unknown'), 0);
  assert.equal(exitCode(report, 'never'), 0);
});

// The grouped not_compared detail names only three example paths; the finding
// itself now carries the full list, and the markdown expands it in a
// collapsible block after the table so an auditor can read every path.
test('renderMarkdown adds a details block listing every path for a grouped not_compared finding', () => {
  const finding = makeFinding({
    kind: 'not_compared',
    severity: 'not_compared',
    endpoint: 'POST /v1/checkout/sessions',
    at: 'requestBody',
    detail: '4 fields were not compared in the current spec — an anyOf/oneOf union — at a, b, c and elsewhere',
    paths: ['a', 'b', 'c', 'd'],
  });
  const markdown = renderMarkdown(makeReport({ findings: [finding] }));
  assert.match(
    markdown,
    /<details><summary>stripe POST \/v1\/checkout\/sessions requestBody: 4 fields not compared<\/summary>/
  );
  assert.match(markdown, /`a`, `b`, `c`, `d`/);
  assert.match(markdown, /<\/details>/);
  // It is an expansion of the table, not a replacement for it.
  assert.ok(markdown.indexOf('<details>') > markdown.indexOf('| Severity |'));
});

test('renderMarkdown adds no details block when paths has three or fewer entries', () => {
  const finding = makeFinding({
    kind: 'not_compared',
    severity: 'not_compared',
    at: 'requestBody',
    detail: '3 fields were not compared in the current spec — an anyOf/oneOf union — at a, b, c',
    paths: ['a', 'b', 'c'],
  });
  const markdown = renderMarkdown(makeReport({ findings: [finding] }));
  assert.equal(markdown.includes('<details>'), false);
});

test('renderMarkdown shows an empty path as (root) and escapes pipes inside the details block', () => {
  const finding = makeFinding({
    kind: 'not_compared',
    severity: 'not_compared',
    at: 'requestBody',
    detail: '4 fields were not compared in the current spec — an anyOf/oneOf union — at (root), a, b and elsewhere',
    paths: ['', 'a|b', 'c', 'd'],
  });
  const markdown = renderMarkdown(makeReport({ findings: [finding] }));
  assert.match(markdown, /`\(root\)`, `a\\\|b`, `c`, `d`/);
});
