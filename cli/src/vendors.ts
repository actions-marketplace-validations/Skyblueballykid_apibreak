/**
 * The vendors this check knows how to read, and — just as importantly — the
 * ones it refuses to pretend about.
 *
 * The registry is short on purpose. Each entry was chosen by measuring what the
 * vendor's own specification actually did over six to twelve months (the
 * numbers below are quoted from that measurement), not by which names look
 * impressive on a landing page:
 *
 *   - **GitHub** removed 8 operations and newly deprecated 7 in six months. It
 *     is the reason this product exists.
 *   - **Stripe** removed nothing and deprecated nothing in twelve months, and
 *     gained exactly one newly required field. It is included because "your
 *     pinned version is n releases behind" is a real question, and because one
 *     true finding a year is still a true finding. It is not the flagship.
 *   - **Twilio** did not change one operation in six months, so it is not here.
 *     A monitoring subject that never moves is a subscription for nothing.
 *
 * Adding a vendor means measuring it first. That measurement is the product's
 * only real moat, and it is also the thing that keeps the reports honest.
 */

export interface VendorSource {
  /** How the vendor is named in `apibreak.json`. */
  id: string;
  label: string;
  /** The GitHub repository that publishes the specification. */
  repo: string;
  /** Path to the specification inside that repository. */
  path: string;
  /** Public URL of the specification at a given revision. */
  rawUrl: (revision: string) => string;
  /** What a caller should understand about how this vendor versions. */
  versioning: string;
  /**
   * What was measured, and when. Quoted on the site so no claim about a vendor
   * is unsourced.
   */
  measured: string;
}

const GITHUB_SPEC_PATH = 'descriptions/api.github.com/api.github.com.json';

export const VENDORS: Record<string, VendorSource> = {
  github: {
    id: 'github',
    label: 'GitHub REST',
    repo: 'github/rest-api-description',
    path: GITHUB_SPEC_PATH,
    rawUrl: (rev) => `https://raw.githubusercontent.com/github/rest-api-description/${rev}/${GITHUB_SPEC_PATH}`,
    versioning:
      'No per-caller version pin. Operations are deprecated in the specification and later removed, so the specification itself is the notice.',
    measured:
      '2026-03-19 → 2026-09-16: 1099 → 1239 operations, 8 removed, 7 newly deprecated, 1 newly required request field; 38 operations currently marked deprecated.',
  },
  stripe: {
    id: 'stripe',
    label: 'Stripe',
    repo: 'stripe/openapi',
    path: 'openapi/spec3.json',
    rawUrl: (rev) => `https://raw.githubusercontent.com/stripe/openapi/${rev}/openapi/spec3.json`,
    versioning:
      'Every account is pinned to a dated API version, so a specification change is an upgrade question rather than an outage. Findings here are worded as upgrade impact.',
    measured:
      '2025-08-19 → 2026-08-26 (twelve months): 570 → 594 operations, 0 removed, 0 newly deprecated, 1 newly required request field (POST /v1/promotion_codes gained "promotion").',
  },
};

export function vendor(id: string): VendorSource | undefined {
  return VENDORS[id.toLowerCase()];
}

export function knownVendors(): string[] {
  return Object.keys(VENDORS).sort();
}
