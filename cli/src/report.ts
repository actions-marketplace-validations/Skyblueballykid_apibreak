/**
 * The report renderer: turns a RunReport into the two artefacts a CI run
 * produces — machine-readable JSON and a GitHub step summary a human reads.
 *
 * The prose rules here are deliberate. Additive changes are counted, never
 * listed; a clean result still names the sources that were compared, so
 * "nothing changed" is always checkable rather than merely asserted; and
 * anything the diff could not read is shown as unknown, never folded into
 * silence.
 */

import {
  SEVERITY_ORDER,
  type Finding,
  type RunReport,
  type Severity,
  type SourcePair,
  type SpecStamp,
} from './types.js';

/**
 * Ordering findings by severity first means the reader meets the breaking
 * changes before the advisories; the remaining keys make the order
 * deterministic so two runs over the same report produce byte-identical
 * output, which is what makes diffing CI summaries possible.
 */
export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (bySeverity !== 0) return bySeverity;
    const byVendor = a.vendor < b.vendor ? -1 : a.vendor > b.vendor ? 1 : 0;
    if (byVendor !== 0) return byVendor;
    const byEndpoint = a.endpoint < b.endpoint ? -1 : a.endpoint > b.endpoint ? 1 : 0;
    if (byEndpoint !== 0) return byEndpoint;
    return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
  });
}

/**
 * A single tally object, so the summary line and the exit code agree by
 * construction rather than by two independent counts drifting apart.
 */
export function summarise(report: RunReport): {
  breaking: number;
  deprecation: number;
  unknown: number;
  advisory: number;
  notCompared: number;
  total: number;
} {
  const counts: Record<Severity, number> = {
    breaking: 0,
    deprecation: 0,
    unknown: 0,
    advisory: 0,
    not_compared: 0,
  };
  for (const finding of report.findings) {
    counts[finding.severity] += 1;
  }
  return {
    breaking: counts.breaking,
    deprecation: counts.deprecation,
    unknown: counts.unknown,
    advisory: counts.advisory,
    notCompared: counts.not_compared,
    total: report.findings.length,
  };
}

/**
 * JSON is what other tooling consumes, so findings are sorted for
 * determinism; the caller's report is copied rather than mutated because a
 * renderer has no business rearranging its input.
 */
export function renderJson(report: RunReport): string {
  const sorted: RunReport = { ...report, findings: sortFindings(report.findings) };
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

/**
 * Every cell holds text a vendor wrote — field names, enum members, `$ref`
 * strings. A newline would end the table row and a pipe would start a new
 * column, so both are neutralised along with any other control character. The
 * text is a vendor's, the formatting is ours.
 */
export function escapeCell(text: string): string {
  return text
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/\|/g, '\\|');
}

/**
 * A stamp renders only what the vendor actually publishes; inventing a
 * version or a commit would defeat the point of provenance, so gaps are
 * simply left out and a stamp with nothing in it says so.
 */
function renderStamp(stamp: SpecStamp): string {
  const commit = stamp.commit ? `commit@${stamp.commit.slice(0, 7)}` : undefined;
  const extras = [commit, stamp.date].filter((part): part is string => part !== undefined);
  if (stamp.version !== undefined && extras.length > 0) {
    return `${stamp.version} (${extras.join(', ')})`;
  }
  if (stamp.version !== undefined) return stamp.version;
  if (extras.length > 0) return extras.join(', ');
  return 'unknown revision';
}

function renderSource(source: SourcePair): string {
  const head = `\`${escapeCell(source.vendor)}\` — ${escapeCell(source.specUrl)}, baseline ${renderStamp(
    source.baseline,
  )} → current ${renderStamp(source.current)}, fetched ${source.fetchedAt}`;
  return source.note ? `${head} — **${escapeCell(source.note)}**` : head;
}

export function pluralise(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}

/**
 * Markdown is what the human reads, so the shape is fixed: counts first,
 * findings as a table sorted worst-first, then the sources that were
 * compared — even on a clean run — and the standing caveat about scope.
 */
export function renderMarkdown(report: RunReport): string {
  const counts = summarise(report);
  const lines: string[] = [];

  lines.push('## APIBreak');
  lines.push('');

  const countParts: string[] = [];
  if (counts.breaking > 0) countParts.push(`**${counts.breaking} breaking**`);
  if (counts.deprecation > 0) countParts.push(`${counts.deprecation} deprecation${counts.deprecation === 1 ? '' : 's'}`);
  if (counts.unknown > 0) countParts.push(`${counts.unknown} unknown`);
  if (counts.advisory > 0) countParts.push(`${counts.advisory} advisory`);
  if (counts.notCompared > 0) countParts.push(`${counts.notCompared} not compared`);
  if (countParts.length === 0) countParts.push('no findings');

  // A zero here is noise: "0 skipped" invites the reader to wonder what was
  // skipped. A non-zero one is the opposite, and must always be visible.
  const skippedClause = report.endpointsSkipped === 0 ? '' : `, ${report.endpointsSkipped} skipped`;
  lines.push(
    `${countParts.join(', ')} — ${report.endpointsChecked} ${pluralise(
      report.endpointsChecked,
      'endpoint',
      'endpoints',
    )} checked${skippedClause}, ${report.additiveChanges} ${pluralise(
      report.additiveChanges,
      'additive change',
      'additive changes',
    )} not listed.`,
  );
  lines.push('');

  if (report.findings.length === 0) {
    lines.push('No breaking or deprecating change to the endpoints you declared, and nothing this check could not read.');
    lines.push('');
  } else {
    lines.push('### Findings');
    lines.push('');
    lines.push('| Severity | Vendor | Endpoint | What changed |');
    lines.push('| --- | --- | --- | --- |');
    for (const finding of sortFindings(report.findings)) {
      const severityCell =
        finding.severity === 'breaking' ? `**${finding.severity}**` : finding.severity;
      const whatChanged = finding.at ? `\`${finding.at}\` — ${finding.detail}` : finding.detail;
      lines.push(
        `| ${severityCell} | ${escapeCell(finding.vendor)} | \`${escapeCell(
          finding.endpoint,
        )}\` | ${escapeCell(whatChanged)} |`,
      );
    }
    lines.push('');

    // The detail line of a grouped refusal names only the first three refused
    // paths; the finding now also carries the full list, and a reader auditing
    // the exclusion set needs every one of them, not three. The block is
    // collapsible so it does not bury the table, and it is emitted in the
    // table's own order so it reads as an expansion of the rows above it.
    for (const finding of sortFindings(report.findings)) {
      if (finding.paths === undefined || finding.paths.length <= 3) continue;
      // Inline code does not render inside <summary> on GitHub, and the text
      // is vendor-written, so it goes in as escaped plain text.
      lines.push(
        `<details><summary>${escapeHtml(`${finding.vendor} ${finding.endpoint} ${finding.at ?? ''}`)}: ${
          finding.paths.length
        } fields not compared</summary>`,
      );
      lines.push('');
      // An empty path is the shape root itself; the detail spells it `(root)`
      // and so does this list.
      lines.push(finding.paths.map((p) => `\`${escapeCell(p === '' ? '(root)' : p)}\``).join(', '));
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }
  }

  lines.push('### Sources');
  lines.push('');
  for (const source of report.sources) {
    lines.push(`- ${renderSource(source)}`);
  }
  lines.push('');
  lines.push(
    'Only the endpoints in your apibreak.json were compared. An endpoint this check could not read at all is listed as unknown and fails the run. A part of a schema outside what it compares — an anyOf/oneOf union, a chain deeper than it follows, an object whose fields the vendor does not enumerate — is listed as not compared, on every run, and never fails one.',
  );
  lines.push('');

  return lines.join('\n');
}

/**
 * The exit code is the only part of the tool a pipeline acts on, so the
 * threshold is defined strictly in SEVERITY_ORDER terms: a finding fails when
 * it is at least as severe as the chosen level, and advisory findings never
 * fail regardless of the setting.
 *
 * `unknown` is the exception, and it is deliberate. An unknown finding means
 * this check could not verify an endpoint the customer declared, and a check
 * that could not look is not a check that passed — a vendor spec returning
 * HTTP 503 would otherwise be indistinguishable from a clean week. So unknown
 * fails at every threshold except `never`, which is the explicit opt-out.
 *
 * `not_compared` never fails. It is a standing limit of the comparison rather
 * than a failed run — Stripe expresses every nullable field as an `anyOf`, so
 * failing on it would redden a Stripe user's build for ever and teach them to
 * stop reading. It stays in the report on every run so the limit is visible.
 */
export function exitCode(
  report: RunReport,
  failOn: 'breaking' | 'deprecation' | 'unknown' | 'never',
): number {
  if (failOn === 'never') return 0;
  const threshold = SEVERITY_ORDER[failOn];
  for (const finding of report.findings) {
    if (finding.severity === 'advisory' || finding.severity === 'not_compared') continue;
    if (finding.severity === 'unknown') return 2;
    if (SEVERITY_ORDER[finding.severity] <= threshold) return 2;
  }
  return 0;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
