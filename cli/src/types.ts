/**
 * The vocabulary of a radar run.
 *
 * Two rules run through every type here, because they are the difference
 * between a monitor that is worth money and one that quietly lies:
 *
 * 1. **Nothing unresolved is ever reported as clean.** A construct the diff
 *    cannot read produces an `unknown` finding, and an endpoint that is not in
 *    the baseline produces `endpoint_not_in_baseline`. Silence is reserved for
 *    "compared, and nothing changed".
 * 2. **Every finding carries its provenance** — which spec commits were
 *    compared and when they were fetched — so a customer can check the claim
 *    against the vendor's own repository without asking us.
 */

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export const METHODS: readonly Method[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

/** `POST /v1/payment_intents` — a method and an OpenAPI path template. */
export interface EndpointRef {
  method: Method;
  path: string;
}

/**
 * `unknown` and `not_compared` are both "this was not verified", and the
 * difference between them decides whether a build goes red.
 *
 * `unknown` means the check did not run against an endpoint: the spec could
 * not be fetched or parsed, the baseline did not resolve, the manifest names
 * an endpoint that is not there. That is indistinguishable from a clean week
 * unless it fails, so it fails.
 *
 * `not_compared` means the check ran and is telling you what it cannot see:
 * a schema built from `anyOf`, a chain deeper than it follows, an object whose
 * fields the vendor does not enumerate. It is a standing property of the
 * vendor's document, identical on every run, so failing on it would just teach
 * the reader to ignore a permanently red build. It is reported on every run
 * and never fails one.
 */
export type Severity = 'breaking' | 'deprecation' | 'advisory' | 'unknown' | 'not_compared';

export type FindingKind =
  /** The operation is in the baseline and gone from the current spec. */
  | 'operation_removed'
  /** The operation gained `deprecated: true`. */
  | 'operation_deprecated'
  /** A request field was added to `required`, at any depth. */
  | 'request_field_now_required'
  /** The request body as a whole went from optional to required. */
  | 'request_body_now_required'
  /** The operation declared a request body in the baseline and declares none now. */
  | 'request_body_removed'
  /** A parameter went from optional to required, or arrived already required. */
  | 'parameter_now_required'
  /** A request field present in the baseline is gone. */
  | 'request_field_removed'
  /** A 2xx response field present in the baseline is gone — the change that breaks parsers silently. */
  | 'response_field_removed'
  /** A declared field changed its `type`. */
  | 'field_type_changed'
  /** An enum lost a member the caller may still be sending. */
  | 'enum_value_removed'
  /** A field that accepted anything now accepts only a fixed set. */
  | 'enum_now_restricted'
  /** A response enum gained a member a caller's parser has never seen. */
  | 'enum_value_added'
  /** A media type the baseline offered is no longer offered. */
  | 'media_type_removed'
  /** A 2xx status the baseline declared is no longer declared. */
  | 'response_status_removed'
  /** The manifest names an endpoint the baseline spec does not contain. Never silent. */
  | 'endpoint_not_in_baseline'
  /**
   * The effective server address (operation > path item > root) for this
   * operation differs between the two documents' URL path component. Which
   * operation this even is may itself be uncertain, so the body and
   * parameters are not compared at all — never `breaking`, never silently
   * treated as unchanged.
   */
  | 'server_changed'
  /**
   * An operation unmatched on ONE side and an operation unmatched on the
   * OTHER side would pair under an ordinary root-prefix move, but the whole
   * document's realignment was skipped because some other part of it has its
   * own `servers` override — so the pairing could not be confirmed. Reported
   * once per pair, `unknown` severity, never `breaking`: it must never be
   * counted as an ordinary `operation_removed` on one side and an ordinary
   * addition on the other, which would otherwise report one real change as
   * two contradictory ones.
   */
  | 'possibly_moved'
  /** The check could not run against this endpoint at all. Reported, never swallowed. */
  | 'unknown'
  /** The check ran; this part of the schema is outside what it compares. Reported, never swallowed. */
  | 'not_compared';

export interface Finding {
  kind: FindingKind;
  severity: Severity;
  vendor: string;
  endpoint: string;
  /** What changed, in one line, with no adjectives. */
  detail: string;
  /** The JSON pointer inside the operation, when there is a specific one. */
  at?: string;
  /**
   * Grouped `not_compared` findings only: every topmost path the comparison
   * refused, relative to `at` (a root path is the empty string), sorted. The
   * detail still names three examples; this is the full list, so a reader can
   * hold the report to every refused path rather than the first three.
   * Single-path findings omit the key entirely — the one path is already
   * `at` — and a finding without it must not carry the key at all, so JSON
   * for every other finding stays byte-identical.
   */
  paths?: string[];
}

export interface SourcePair {
  vendor: string;
  specUrl: string;
  baseline: SpecStamp;
  current: SpecStamp;
  /** ISO 8601. When the current spec was read, not when the report was rendered. */
  fetchedAt: string;
  /**
   * Why this pair was not compared, when it was not. Provenance is recorded
   * before the network is touched precisely so a failed run still says which
   * vendor, which document and which revisions it was reaching for — the run
   * where a customer most needs to know is the run that did not work.
   */
  note?: string;
}

export interface SpecStamp {
  /** The vendor repository commit the spec was read at, when one is known. */
  commit?: string;
  /** The vendor's own version string out of `info.version`, when it publishes one. */
  version?: string;
  /** ISO 8601 commit date, when known. */
  date?: string;
}

export interface RunReport {
  /** ISO 8601. */
  generatedAt: string;
  sources: SourcePair[];
  /** How many declared endpoints were actually compared. */
  endpointsChecked: number;
  /** Declared endpoints that could not be compared, for any reason. */
  endpointsSkipped: number;
  /**
   * Additive changes are counted and not listed. A radar that reports every
   * added optional field trains its reader to ignore it.
   */
  additiveChanges: number;
  findings: Finding[];
}

export const SEVERITY_ORDER: Record<Severity, number> = {
  breaking: 0,
  deprecation: 1,
  unknown: 2,
  advisory: 3,
  not_compared: 4,
};
