/**
 * Getting two revisions of a vendor specification, with the revision resolved
 * from whatever the customer wrote in `apibreak.json`.
 *
 * Network behaviour is confined to this file so the diff, the report and the
 * site can all be tested and built offline. Nothing here retries forever and
 * nothing here caches silently: a failure returns a message the report prints,
 * because "could not fetch" must surface as unknown rather than as clean.
 *
 * Every request here has two deadlines: a stall deadline (no response headers,
 * or no body bytes, for `stallMs`) and a total ceiling (`totalMs`) that cuts
 * off a server which trickles one byte at a time for ever. A request that
 * times out is not an exit-1 crash: it becomes an `unknown` finding, which
 * fails the build at every --fail-on level except `never` — deliberately,
 * because an integration the check could not verify must not pass as clean.
 */

import type { SpecStamp } from './types.js';
import type { VendorSource } from './vendors.js';

export interface Revision {
  stamp: SpecStamp;
  /** The revision string to fetch the raw file at. */
  ref: string;
  /**
   * Set when `ref` is a moving branch name because the commit could not be
   * resolved. The run turns this into an `unknown` finding: a report that
   * cites `main` cannot be rechecked a week later, so it is not provenance.
   */
  unresolved?: string;
}

export interface FetchDeps {
  fetch: typeof fetch;
  /** Injected so a run is reproducible in tests. */
  now: () => Date;
  /** Optional token; the GitHub commit API is rate-limited hard when anonymous. */
  githubToken?: string;
  /**
   * Stall deadline and total ceiling for every request. The specs are
   * megabytes, so the stall deadline (per quiet gap) is short while the total
   * ceiling (whole request) is long: a slow connection that keeps moving is
   * fine, a connection that goes quiet is not.
   */
  deadlines?: { stallMs: number; totalMs: number };
}

/** Used whenever `deps.deadlines` is absent: 30 s of silence, 5 min overall. */
export const DEFAULT_DEADLINES: { stallMs: number; totalMs: number } = {
  stallMs: 30_000,
  totalMs: 300_000,
};

/** 900 → "1 s", 300 → "300 ms" — tests use small values, production seconds. */
function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`;
}

export function httpOk(status: number): boolean {
  return status >= 200 && status < 300;
}

export type BodyResult =
  | { ok: true; status: number; text: string }
  | { ok: false; error: string };

function parseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * One GET with the two deadlines armed, returning the status and the whole
 * body as text — including for non-2xx, whose formatting stays with the
 * callers, which already know what URL and what vendor they were asking for.
 *
 * The stall timer covers the wait for the response headers and is re-armed on
 * every body chunk; the total timer runs once and aborts regardless of
 * progress, so a server that dribbles one byte just under the stall deadline
 * still cannot hold the job for ever. The body is read through a stream and
 * decoded with `stream: true`, because a multibyte character split across two
 * chunks must survive the concatenation.
 */
export async function getBody(
  url: string,
  init: RequestInit | undefined,
  deps: FetchDeps
): Promise<BodyResult> {
  const deadlines = deps.deadlines ?? DEFAULT_DEADLINES;
  const controller = new AbortController();

  // Which timer fired decides the message, so the flags are read after the
  // catch. Re-arming clears the flag: a gap that produced bytes was not a
  // stall, and only the current gap may count.
  let stalled = false;
  let exhausted = false;
  let stallTimer: NodeJS.Timeout | undefined;
  const armStall = (): void => {
    clearTimeout(stallTimer);
    stalled = false;
    stallTimer = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, deadlines.stallMs);
  };
  const totalTimer = setTimeout(() => {
    exhausted = true;
    controller.abort();
  }, deadlines.totalMs);

  try {
    armStall();
    const res = await deps.fetch(url, { ...init, signal: controller.signal });
    // Headers are progress too: the gap to the first body byte is a new gap.
    armStall();
    let text: string;
    if (!res.body) {
      // Undici always exposes a body here, but the type says it may be null —
      // and a fetch injected into FetchDeps by a caller (scripts/provenance,
      // tests) may hand back a plain object that only implements json().
      if (typeof res.text === 'function') {
        text = await res.text();
      } else {
        text = JSON.stringify(await res.json());
      }
    } else {
      const decoder = new TextDecoder();
      const parts: string[] = [];
      const reader = res.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          armStall();
          parts.push(decoder.decode(value, { stream: true }));
        }
        // Flush any multibyte character left half-decoded at the end.
        parts.push(decoder.decode());
      } finally {
        // Cancel so an abandoned response does not keep a socket open past
        // the caller's interest in it; cancelling a finished reader is a no-op.
        void reader.cancel().catch(() => undefined);
      }
      text = parts.join('');
    }
    return { ok: true, status: res.status, text };
  } catch (e) {
    if (!controller.signal.aborted) controller.abort();
    if (exhausted) {
      return { ok: false, error: `${url} did not finish within ${formatDuration(deadlines.totalMs)}` };
    }
    if (stalled) {
      return { ok: false, error: `no response from ${url} for ${formatDuration(deadlines.stallMs)}` };
    }
    return { ok: false, error: `could not reach ${url}: ${(e as Error).message}` };
  } finally {
    clearTimeout(stallTimer);
    clearTimeout(totalTimer);
  }
}

const SHA_RE = /^[0-9a-f]{7,40}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A baseline may be a commit sha or a date. A date is resolved to the last
 * commit that touched the specification on or before it, which is what a human
 * means by "the spec as it was in March".
 */
export async function resolveRevision(
  source: VendorSource,
  baseline: string,
  deps: FetchDeps
): Promise<Revision | { error: string }> {
  if (SHA_RE.test(baseline)) {
    const meta = await commitMeta(source, baseline, deps);
    return { ref: baseline, stamp: { commit: baseline, date: meta?.date } };
  }
  if (!DATE_RE.test(baseline)) {
    return { error: `baseline "${baseline}" is neither a commit sha nor a YYYY-MM-DD date` };
  }
  const until = `${baseline}T23:59:59Z`;
  const url = `https://api.github.com/repos/${source.repo}/commits?path=${encodeURIComponent(
    source.path
  )}&per_page=1&until=${until}`;

  const res = await getBody(url, { headers: headers(deps) }, deps);
  if (!res.ok) return { error: res.error };
  if (!httpOk(res.status)) {
    return { error: `could not list ${source.repo} commits (HTTP ${res.status})` };
  }
  const body = parseJson(res.text);
  if (!Array.isArray(body) || body.length === 0) {
    return { error: `no commit to ${source.path} on or before ${baseline}` };
  }
  const revision = commitFrom(body[0]);
  if (!revision) return { error: `unexpected commit listing for ${source.repo}` };
  return revision;
}

/**
 * Vendor and API responses are untrusted input: a commit listing may be an
 * error object, an array with a null in it, or HTML. Every reader here answers
 * "could not tell" rather than throwing, because a thrown error inside one
 * integration would abandon the report for all the others.
 */
function commitFrom(entry: unknown): Revision | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const e = entry as { sha?: unknown; commit?: unknown };
  if (typeof e.sha !== 'string' || e.sha.length === 0) return undefined;
  const commit = e.commit && typeof e.commit === 'object' ? (e.commit as { author?: unknown }) : undefined;
  const author = commit?.author && typeof commit.author === 'object' ? (commit.author as { date?: unknown }) : undefined;
  const date = typeof author?.date === 'string' ? author.date : undefined;
  return { ref: e.sha, stamp: { commit: e.sha, date } };
}

async function commitMeta(
  source: VendorSource,
  sha: string,
  deps: FetchDeps
): Promise<{ date?: string } | undefined> {
  // Best effort, but bounded: a stalling commit-meta call used to be able to
  // hold the whole run, and a missing commit date is only ever provenance
  // detail, never worth a hang.
  const res = await getBody(
    `https://api.github.com/repos/${source.repo}/commits/${sha}`,
    { headers: headers(deps) },
    deps
  );
  if (!res.ok || !httpOk(res.status)) return undefined;
  return { date: commitFrom(parseJson(res.text))?.stamp.date };
}

function headers(deps: FetchDeps): Record<string, string> {
  const h: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'apibreak',
  };
  if (deps.githubToken) h.authorization = `Bearer ${deps.githubToken}`;
  return h;
}

export interface FetchedSpec {
  raw: unknown;
  stamp: SpecStamp;
  url: string;
  fetchedAt: string;
}

export async function fetchSpec(
  source: VendorSource,
  revision: Revision,
  deps: FetchDeps
): Promise<FetchedSpec | { error: string }> {
  const url = source.rawUrl(revision.ref);
  const res = await getBody(url, { headers: { 'user-agent': 'apibreak' } }, deps);
  if (!res.ok) return { error: res.error };
  if (!httpOk(res.status)) return { error: `could not fetch ${url} (HTTP ${res.status})` };
  let raw: unknown;
  try {
    raw = JSON.parse(res.text);
  } catch {
    return { error: `${url} did not parse as JSON` };
  }
  const version =
    raw && typeof raw === 'object' && 'info' in raw
      ? ((raw as { info?: { version?: unknown } }).info?.version as string | undefined)
      : undefined;
  return {
    raw,
    url,
    stamp: { ...revision.stamp, version: typeof version === 'string' ? version : undefined },
    fetchedAt: deps.now().toISOString(),
  };
}

/**
 * The revision the vendor publishes right now.
 *
 * The commit is resolved rather than left as a branch name, because provenance
 * is most of what this tool sells: a finding that cites `main` is uncheckable a
 * week later, and one that cites a sha is checkable forever. If the listing
 * call fails — anonymous rate limits are easy to hit — the branch name is used
 * and the revision is marked unresolved, which the run turns into an `unknown`
 * finding rather than presenting a moving branch as provenance.
 */
export async function resolveHead(source: VendorSource, deps: FetchDeps): Promise<Revision> {
  const url = `https://api.github.com/repos/${source.repo}/commits?path=${encodeURIComponent(
    source.path
  )}&per_page=1`;
  let why = 'the commit listing did not return a sha';
  const res = await getBody(url, { headers: headers(deps) }, deps);
  if (!res.ok) {
    why = res.error;
  } else if (httpOk(res.status)) {
    const body = parseJson(res.text);
    if (Array.isArray(body) && body.length > 0) {
      const revision = commitFrom(body[0]);
      if (revision) return revision;
    }
  } else {
    why = `the commit listing returned HTTP ${res.status}`;
  }
  const branch = defaultBranch(source);
  return {
    ref: branch,
    stamp: {},
    unresolved: `the current revision could not be pinned to a commit, so the comparison used the moving \`${branch}\` branch (${why})`,
  };
}

function defaultBranch(source: VendorSource): string {
  // Both registry entries publish from a long-lived branch; this is a lookup
  // rather than a guess, and a new vendor must state its own.
  return source.repo === 'stripe/openapi' ? 'master' : 'main';
}
