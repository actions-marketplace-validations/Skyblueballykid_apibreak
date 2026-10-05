/**
 * `apibreak.json` — the customer's declaration of what they call.
 *
 * It is deliberately the only input. No repository scanning, no credentials, no
 * traffic interception: the check runs in their CI and reads a file they wrote.
 * That is what makes it installable without a procurement conversation.
 */

import { METHODS, type EndpointRef, type Method } from './types.js';

export interface IntegrationSpec {
  vendor: string;
  /**
   * The vendor spec revision the customer last reconciled against — a commit
   * sha or an ISO date. Everything is reported relative to this, so a run is
   * reproducible and a report cannot drift on its own.
   */
  baseline: string;
  endpoints: EndpointRef[];
}

export interface Manifest {
  version: 1;
  integrations: IntegrationSpec[];
}

export type ParseResult =
  | { ok: true; manifest: Manifest; warnings: string[] }
  | { ok: false; errors: string[] };

const ENDPOINT_RE = /^(?<method>[A-Za-z]+)\s+(?<path>\/\S*)$/;

/**
 * `"POST /v1/payment_intents"` → `{ method: 'POST', path: '/v1/payment_intents' }`.
 *
 * Accepts the object form too, so a generator can write either. Returns null
 * rather than throwing: a bad line is a reported error, not a crashed run.
 */
export function parseEndpoint(input: unknown): EndpointRef | null {
  if (typeof input === 'string') {
    const m = ENDPOINT_RE.exec(input.trim());
    const rawMethod = m?.groups?.method;
    const rawPath = m?.groups?.path;
    if (!rawMethod || !rawPath) return null;
    const method = rawMethod.toUpperCase() as Method;
    if (!METHODS.includes(method)) return null;
    return { method, path: rawPath };
  }
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    const method = typeof o.method === 'string' ? (o.method.toUpperCase() as Method) : null;
    const path = typeof o.path === 'string' ? o.path : null;
    if (!method || !path || !METHODS.includes(method) || !path.startsWith('/')) return null;
    return { method, path };
  }
  return null;
}

export function parseManifest(input: unknown): ParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['apibreak.json must be a JSON object.'] };
  }
  const body = input as Record<string, unknown>;

  if (body.version !== 1) {
    errors.push('apibreak.json needs "version": 1.');
  }
  if (!Array.isArray(body.integrations) || body.integrations.length === 0) {
    return { ok: false, errors: [...errors, 'apibreak.json needs a non-empty "integrations" array.'] };
  }

  const integrations: IntegrationSpec[] = [];
  const seen = new Set<string>();

  body.integrations.forEach((raw, i) => {
    const where = `integrations[${i}]`;
    if (!raw || typeof raw !== 'object') {
      errors.push(`${where} must be an object.`);
      return;
    }
    const o = raw as Record<string, unknown>;
    const vendor = typeof o.vendor === 'string' ? o.vendor.trim().toLowerCase() : '';
    const baseline = typeof o.baseline === 'string' ? o.baseline.trim() : '';
    if (!vendor) errors.push(`${where}.vendor is required.`);
    if (!baseline) errors.push(`${where}.baseline is required — a commit sha or an ISO date.`);
    if (seen.has(vendor)) errors.push(`${where}.vendor "${vendor}" appears twice; merge the two entries.`);
    seen.add(vendor);

    const rawEndpoints = Array.isArray(o.endpoints) ? o.endpoints : [];
    const endpoints: EndpointRef[] = [];
    rawEndpoints.forEach((e, j) => {
      const parsed = parseEndpoint(e);
      if (!parsed) {
        errors.push(`${where}.endpoints[${j}] is not "METHOD /path": ${JSON.stringify(e)}`);
        return;
      }
      const key = `${parsed.method} ${parsed.path}`;
      if (endpoints.some((x) => `${x.method} ${x.path}` === key)) {
        warnings.push(`${where}.endpoints[${j}] repeats ${key}; the duplicate is ignored.`);
        return;
      }
      endpoints.push(parsed);
    });

    if (endpoints.length === 0) {
      // Declaring a vendor and no endpoints would silently compare nothing and
      // report a clean run, which is the one outcome this product must never
      // produce.
      errors.push(`${where}.endpoints is empty; list the endpoints you actually call.`);
    }
    if (vendor && baseline) integrations.push({ vendor, baseline, endpoints });
  });

  if (errors.length) return { ok: false, errors };
  return { ok: true, manifest: { version: 1, integrations }, warnings };
}
