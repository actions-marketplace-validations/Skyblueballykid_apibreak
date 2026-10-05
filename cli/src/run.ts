/**
 * One radar run: manifest in, report out.
 *
 * Separated from the CLI so the same function backs the command line, the
 * GitHub Action and the site's own generated snapshots. Every dependency that
 * touches the network or the clock is injected, which is what makes the whole
 * pipeline testable without a fixture server.
 *
 * Provenance is opened before anything is fetched and closed with whatever was
 * learned, successfully or not. A run that fails is the run where a customer
 * most needs to see which vendor, which document and which revisions were
 * being compared, and an earlier version recorded sources only on the happy
 * path — so the reports that needed provenance were the ones without it.
 */

import { diffEndpoints } from './diff.js';
import { fetchSpec, resolveHead, resolveRevision, type FetchDeps } from './fetch.js';
import { indexSpec } from './spec.js';
import type { Manifest } from './manifest.js';
import type { Finding, RunReport, SourcePair } from './types.js';
import { vendor as lookupVendor, knownVendors } from './vendors.js';

export async function runRadar(manifest: Manifest, deps: FetchDeps): Promise<RunReport> {
  const findings: Finding[] = [];
  const sources: SourcePair[] = [];
  let checked = 0;
  let skipped = 0;
  let additive = 0;

  for (const integration of manifest.integrations) {
    const endpointsLabel = `${integration.endpoints.length} endpoint${
      integration.endpoints.length === 1 ? '' : 's'
    }`;

    const source = lookupVendor(integration.vendor);
    if (!source) {
      // An unknown vendor is a finding, not a crash and not a silent skip. The
      // registry is deliberately short and the message says so.
      skipped += integration.endpoints.length;
      findings.push({
        kind: 'unknown',
        severity: 'unknown',
        vendor: integration.vendor,
        endpoint: endpointsLabel,
        detail: `no specification source is registered for "${integration.vendor}"; known vendors are ${knownVendors().join(', ')}`,
      });
      continue;
    }

    // Opened now, amended as revisions resolve, pushed on every exit path.
    const provenance: SourcePair = {
      vendor: source.id,
      specUrl: `https://github.com/${source.repo}/blob/HEAD/${source.path}`,
      baseline: {},
      current: {},
      fetchedAt: deps.now().toISOString(),
    };
    const giveUp = (note: string, detail: string): void => {
      skipped += integration.endpoints.length;
      provenance.note = note;
      sources.push(provenance);
      findings.push({
        kind: 'unknown',
        severity: 'unknown',
        vendor: source.id,
        endpoint: endpointsLabel,
        detail,
      });
    };

    const baseline = await resolveRevision(source, integration.baseline, deps);
    if ('error' in baseline) {
      giveUp(
        `the baseline "${integration.baseline}" did not resolve, so nothing was compared`,
        `baseline not resolved: ${baseline.error}`
      );
      continue;
    }
    provenance.baseline = baseline.stamp;

    const head = await resolveHead(source, deps);
    provenance.current = head.stamp;
    if (head.unresolved) {
      // The comparison still runs — a moving branch is real content — but a
      // finding the customer cannot recheck later is not a passing check.
      findings.push({
        kind: 'unknown',
        severity: 'unknown',
        vendor: source.id,
        endpoint: endpointsLabel,
        detail: head.unresolved,
      });
    }

    const [before, after] = await Promise.all([
      fetchSpec(source, baseline, deps),
      fetchSpec(source, head, deps),
    ]);
    if ('error' in before || 'error' in after) {
      const failure = 'error' in before ? before.error : 'error' in after ? after.error : 'fetch failed';
      giveUp('the specification could not be fetched, so nothing was compared', `specification not compared: ${failure}`);
      continue;
    }

    provenance.specUrl = after.url;
    provenance.baseline = before.stamp;
    provenance.current = after.stamp;
    provenance.fetchedAt = after.fetchedAt;
    sources.push(provenance);

    const result = diffEndpoints({
      vendor: source.id,
      baseline: indexSpec(before.raw),
      current: indexSpec(after.raw),
      endpoints: integration.endpoints,
    });
    findings.push(...result.findings);
    checked += result.endpointsChecked;
    skipped += result.endpointsSkipped;
    additive += result.additiveChanges;
  }

  return {
    generatedAt: deps.now().toISOString(),
    sources,
    endpointsChecked: checked,
    endpointsSkipped: skipped,
    additiveChanges: additive,
    findings,
  };
}
