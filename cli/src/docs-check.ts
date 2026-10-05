/**
 * Checking documented API calls against the spec — the judging half of
 * `apibreak docs`. `docs-extract.ts` finds the calls; this decides which of
 * them the spec no longer supports.
 *
 * Every rule here leans the same way: a finding is raised only when the spec
 * says something definite. A body schema that allows extra properties, an
 * unresolvable `$ref`, two path templates that fit equally well, an example
 * whose body could not be read — each of these switches the dependent check
 * off for that reference rather than producing a finding the reader then has
 * to argue with. A docs check that cries wolf gets deleted from CI.
 */

import { SUBSTITUTION, type BodyRef, type DocReference } from './docs-extract.js';
import { closestTemplate, matchDocPath, nameDistance, operationServerBases, serverBases, type ServerBase } from './match-endpoints.js';
import { deref, parameters, type Json, type Operation, type SpecDoc } from './spec.js';
import { METHODS, type Method } from './types.js';

export type DocsRule =
  | 'unknown-endpoint'
  | 'wrong-method'
  | 'unknown-body-field'
  | 'unknown-query-param'
  | 'missing-required'
  | 'deprecated-operation'
  | 'deprecated-field';

export type DocsSeverity = 'error' | 'warning';

export const RULE_SEVERITY: Record<DocsRule, DocsSeverity> = {
  'unknown-endpoint': 'error',
  'wrong-method': 'error',
  'unknown-body-field': 'error',
  'unknown-query-param': 'error',
  'missing-required': 'error',
  'deprecated-operation': 'warning',
  'deprecated-field': 'warning',
};

export interface DocsFinding {
  rule: DocsRule;
  severity: DocsSeverity;
  file: string;
  line: number;
  snippet: string;
  /** `METHOD url` as the docs wrote it. */
  reference: string;
  /** The path that was compared: host and server prefix removed. */
  path: string;
  /** The spec operation it was matched to, when one was. */
  operation?: string;
  detail: string;
  hint: string;
}

export interface IgnoredReference {
  file: string;
  line: number;
  snippet: string;
  host: string;
}

export interface CheckResult {
  findings: DocsFinding[];
  /** References on a host the spec and --base-url do not name. */
  ignored: IgnoredReference[];
  /** References whose URL could not be reduced to a path (counted as unparsed by the caller). */
  unresolved: Array<{ ref: DocReference; reason: string }>;
  /** References compared against the spec. */
  checked: number;
  /** Bodies sent by a checked reference that could not be read, so no body finding was possible. */
  bodiesNotRead: number;
  /** Query strings sent by a checked reference that could not be fully read (a variable stood in for a parameter), so no query finding was possible. */
  queriesNotRead: number;
}

// ------------------------------------------------------------ URL → path --

export type Resolved =
  /** `variableHost`: the host was a placeholder or variable (`<your-app>.fly.dev`, `$API`), as written. */
  | { kind: 'path'; candidates: string[]; variableHost?: string }
  | { kind: 'other-host'; host: string }
  | { kind: 'unresolved'; reason: string };

/** `--base-url` values → server bases. A bare `/prefix` names a prefix and no host. */
export function baseUrlBases(values: string[]): ServerBase[] {
  const bases: ServerBase[] = [];
  for (const v of values) {
    const m = /^(?:[a-z][a-z0-9+.-]*:)?\/\/([^/?#]+)([^?#]*)/i.exec(v);
    if (m) {
      const host = m[1]!.toLowerCase();
      bases.push({
        host: new RegExp(`^${host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${host.includes(':') ? '' : '(?::\\d+)?'}$`),
        hostLabel: host,
        prefix: m[2]!.replace(/\/+$/, ''),
      });
    } else if (v.startsWith('/')) {
      bases.push({ host: null, hostLabel: null, prefix: v.replace(/\/+$/, '') });
    }
  }
  return bases;
}

/** A leading base-URL variable: `$API`, `${API}`, `{{baseUrl}}`, `{BASE_URL}`, `<your-host>`, `YOUR_API_URL`. */
const LEADING_VARIABLE = /^(?:\$\{[^}]+\}|\$[A-Za-z_][A-Za-z0-9_]*|\{\{[^}]+\}\}|\{[^}/]+\}|<[^>/]+>|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)/;

/**
 * Reduces a documented URL to candidate spec paths: the host checked against
 * the known servers, every known server prefix it starts with stripped (most
 * specific first), the path itself last. The candidates are tried in order
 * and the first one that fits a template wins, so a stripped prefix never
 * turns a matching path into a non-matching one.
 */
export function resolveUrl(url: string, bases: ServerBase[]): Resolved {
  let rest = url.split('#')[0]!.split('?')[0]!.trim();
  let hostKnown: ServerBase[] | null = null;
  let variableHost: string | undefined;

  const abs = /^(?:[a-z][a-z0-9+.-]*:)?\/\/([^/?#]*)(.*)$/i.exec(rest);
  const bareHost = /^((?:localhost|[\w-]+(?:\.[\w-]+)+)(?::\d+)?)(\/.*)$/i.exec(rest);
  if (abs || bareHost) {
    const host = (abs ? abs[1]! : bareHost![1]!).toLowerCase();
    rest = (abs ? abs[2]! : bareHost![2]!) || '/';
    // A host the spec's own servers match (templated ones included, so
    // `{tenant}.example.com` against `https://{tenant}.example.com`) is this API.
    const matching = bases.filter((b) => b.host?.test(host));
    if (matching.length > 0) {
      hostKnown = matching;
    } else if (LEADING_VARIABLE.test(host) || /^\{|\$|</.test(host)) {
      hostKnown = null; // a variable host: whatever the reader's deployment is
      variableHost = host;
    } else {
      return { kind: 'other-host', host };
    }
  } else {
    const v = LEADING_VARIABLE.exec(rest);
    if (v) {
      variableHost = v[0];
      rest = rest.slice(v[0].length);
      if (rest === '' || rest === '/') return { kind: 'unresolved', reason: `"${url}" is only a base-URL variable, with no path to check` };
    }
    if (!rest.startsWith('/')) return { kind: 'unresolved', reason: `"${url}" does not start with a path, a known host or a base-URL variable` };
  }

  // A URL passed as the last path segment (`/v2/publish/https://example.com`)
  // is one parameter value: kept whole as a single segment, never collapsed
  // into `https:/example.com` and split across segments the spec does not have.
  const embedded = /\/[a-z][a-z0-9+.-]*:\/\//i.exec(rest);
  if (embedded) {
    rest = `${rest.slice(0, embedded.index + 1)}${encodeURIComponent(rest.slice(embedded.index + 1))}`;
  }

  // A path built by a command substitution could be any number of segments.
  if (rest.includes(SUBSTITUTION)) return { kind: 'unresolved', reason: `"${url}" builds its path with a command substitution` };

  // Percent-encoded braces are still placeholders; anything else stays as written.
  rest = rest.replace(/%7B/gi, '{').replace(/%7D/gi, '}').replace(/\/{2,}/g, '/');

  const prefixes = [...new Set((hostKnown ?? bases).map((b) => b.prefix).filter((p) => p !== ''))].sort(
    (a, b) => b.length - a.length
  );
  const candidates: string[] = [];
  for (const prefix of prefixes) {
    if (rest === prefix || rest.startsWith(`${prefix}/`)) candidates.push(rest.slice(prefix.length) || '/');
  }
  candidates.push(rest);
  return { kind: 'path', candidates: [...new Set(candidates)], ...(variableHost ? { variableHost } : {}) };
}

// ------------------------------------------------------- schema reading --

interface PropInfo {
  deprecated: boolean;
  readOnly: boolean;
}

/** What a request body (or an object-typed parameter) lets a caller send at its top level. */
export interface PropSet {
  props: Map<string, PropInfo>;
  /** Required in every case: allOf branches add, oneOf/anyOf branches must all agree. */
  required: Set<string>;
  /** Extra keys are allowed (or the schema is too loose to say they are not). */
  open: boolean;
  /** Set when part of the schema could not be read; no finding may depend on it. */
  unresolved?: string;
}

const MAX_DEPTH = 8;

/**
 * Top-level properties of a schema. `allOf` is merged, `oneOf`/`anyOf` is a
 * union of properties (any branch's field may be sent) and an intersection of
 * `required` (a field is missing only if every branch requires it). An
 * object is open when it says `additionalProperties: true` or a schema, or
 * when it declares no properties at all; `additionalProperties: false` and an
 * absent `additionalProperties` alongside declared properties are closed —
 * the second is a judgement, made because a hand-written example with a field
 * the spec never lists is the drift this check exists to catch.
 */
export function objectProps(schema: Json, doc: Json, depth = 0): PropSet {
  const empty = (open: boolean, unresolved?: string): PropSet => ({
    props: new Map(),
    required: new Set(),
    open,
    ...(unresolved ? { unresolved } : {}),
  });
  if (depth > MAX_DEPTH) return empty(true, 'the schema nests deeper than this check follows');
  const r = deref(schema, doc);
  if (!r.ok) return empty(true, r.reason);
  const node = r.node;
  if (node === true || node === undefined || node === null) return empty(true);
  if (typeof node !== 'object' || Array.isArray(node)) return empty(true);

  const out: PropSet = empty(false);
  let declares = false;

  const props = node.properties;
  if (props && typeof props === 'object' && !Array.isArray(props)) {
    declares = true;
    for (const [name, sub] of Object.entries(props as Record<string, Json>)) {
      const s = deref(sub, doc);
      const n = s.ok ? s.node : undefined;
      out.props.set(name, { deprecated: n?.deprecated === true, readOnly: n?.readOnly === true });
    }
  }
  if (Array.isArray(node.required)) for (const k of node.required) if (typeof k === 'string') out.required.add(k);

  const ap = node.additionalProperties;
  if (ap === true || (ap && typeof ap === 'object')) out.open = true;
  if (node.patternProperties || node.unevaluatedProperties === true) out.open = true;

  if (Array.isArray(node.allOf)) {
    for (const part of node.allOf) {
      const p = objectProps(part, doc, depth + 1);
      if (p.unresolved) return { ...out, open: true, unresolved: p.unresolved };
      if (p.props.size > 0) declares = true;
      for (const [k, v] of p.props) if (!out.props.has(k)) out.props.set(k, v);
      for (const k of p.required) out.required.add(k);
      // A branch that declares nothing constrains nothing; only an explicit opening opens the merge.
      if (p.open && p.props.size > 0) out.open = true;
      const pr = deref(part, doc);
      const pn = pr.ok ? pr.node : undefined;
      if (pn && typeof pn === 'object' && (pn.additionalProperties === true || (pn.additionalProperties && typeof pn.additionalProperties === 'object'))) {
        out.open = true;
      }
    }
  }

  for (const key of ['oneOf', 'anyOf'] as const) {
    if (!Array.isArray(node[key])) continue;
    let shared: Set<string> | undefined;
    for (const part of node[key] as Json[]) {
      const p = objectProps(part, doc, depth + 1);
      if (p.unresolved) return { ...out, open: true, unresolved: p.unresolved };
      if (p.open) out.open = true;
      if (p.props.size > 0) declares = true;
      for (const [k, v] of p.props) if (!out.props.has(k)) out.props.set(k, v);
      const prev: Set<string> | undefined = shared;
      shared = prev === undefined ? new Set(p.required) : new Set([...prev].filter((k) => p.required.has(k)));
    }
    for (const k of shared ?? []) out.required.add(k);
  }

  if (node.type === 'array' || (Array.isArray(node.type) && !node.type.includes('object'))) return empty(true);
  if (!declares) out.open = true;
  // readOnly fields are response-only; a request is never required to send them.
  for (const [k, v] of out.props) if (v.readOnly) out.required.delete(k);
  return out;
}

// ---------------------------------------------------------------- checks --

/** Query parameter names an `apiKey` security scheme declares (`in: query`): legitimate on any operation. */
function apiKeyQueryNames(doc: Json): string[] {
  const schemes = { ...(doc?.securityDefinitions ?? {}), ...(doc?.components?.securitySchemes ?? {}) } as Record<string, Json>;
  const names: string[] = [];
  for (const raw of Object.values(schemes)) {
    const r = deref(raw, doc);
    const s = r.ok ? r.node : undefined;
    if (s?.type === 'apiKey' && s.in === 'query' && typeof s.name === 'string') names.push(s.name);
  }
  return names;
}

function closestName(name: string, candidates: Iterable<string>): string | undefined {
  const norm = (s: string): string => s.toLowerCase().replace(/[-_]/g, '');
  let best: { c: string; d: number } | undefined;
  for (const c of candidates) {
    const d = norm(c) === norm(name) ? 0 : nameDistance(name.toLowerCase(), c.toLowerCase());
    if (!best || d < best.d) best = { c, d };
  }
  if (!best) return undefined;
  return best.d <= Math.max(2, Math.floor(name.length / 3)) ? best.c : undefined;
}

function listNames(names: Iterable<string>, max = 8): string {
  const all = [...names].sort();
  const shown = all.slice(0, max).map((n) => `\`${n}\``).join(', ');
  return all.length > max ? `${shown} and ${all.length - max} more` : shown || '(none)';
}

/** `metadata[order_id]`, `ids[]` → `metadata`, `ids`. */
const baseName = (k: string): string => k.replace(/\[.*$/, '');

const BODY_MEDIA: Record<Exclude<BodyRef['encoding'], 'unknown'>, (ct: string) => boolean> = {
  json: (ct) => /json/i.test(ct),
  form: (ct) => /x-www-form-urlencoded/i.test(ct),
  multipart: (ct) => /multipart\/form-data/i.test(ct),
};

export interface CheckOptions {
  baseUrls?: string[];
}

/** Every documented reference against one spec. */
export function checkReferences(refs: DocReference[], spec: SpecDoc, opts: CheckOptions = {}): CheckResult {
  const baseUrlOverrides = baseUrlBases(opts.baseUrls ?? []);
  const bases = [...serverBases(spec.raw), ...baseUrlOverrides];
  const byPath = new Map<string, Map<Method, Operation>>();
  for (const [key, op] of spec.operations) {
    const sp = key.indexOf(' ');
    const method = key.slice(0, sp) as Method;
    const path = key.slice(sp + 1);
    let m = byPath.get(path);
    if (!m) byPath.set(path, (m = new Map()));
    m.set(method, op);
  }
  const templates = [...byPath.keys()];
  const queryKeyNames = apiKeyQueryNames(spec.raw);

  const result: CheckResult = { findings: [], ignored: [], unresolved: [], checked: 0, bodiesNotRead: 0, queriesNotRead: 0 };
  const seen = new Set<string>();

  for (const ref of refs) {
    const resolved = resolveUrl(ref.url, bases);
    if (resolved.kind === 'other-host') {
      result.ignored.push({ file: ref.file, line: ref.line, snippet: ref.snippet, host: resolved.host });
      continue;
    }
    if (resolved.kind === 'unresolved') {
      result.unresolved.push({ ref, reason: resolved.reason });
      continue;
    }
    // A placeholder host (`<your-app>.fly.dev`, `<DEPLOYMENT_URL>`, `$HOST`) is
    // as often the reader's own app as this API. It counts as this API only
    // when the path says so — it fits a spec path, or starts with a server
    // prefix — and is otherwise skipped like any other host, never reported
    // as an unknown endpoint of an API it may not be calling.
    if (
      resolved.variableHost !== undefined &&
      resolved.candidates.length === 1 &&
      matchDocPath(resolved.candidates[0]!, templates).length === 0
    ) {
      result.ignored.push({ file: ref.file, line: ref.line, snippet: ref.snippet, host: resolved.variableHost });
      continue;
    }
    result.checked += 1;

    let docPath = resolved.candidates[0]!;
    const written = `${ref.method} ${ref.url.length > 120 ? `${ref.url.slice(0, 119)}…` : ref.url}`;
    const emit = (rule: DocsRule, detail: string, hint: string, operation?: string): void => {
      const id = `${ref.file}:${ref.line}:${rule}:${detail}`;
      if (seen.has(id)) return;
      seen.add(id);
      result.findings.push({
        rule,
        severity: RULE_SEVERITY[rule],
        file: ref.file,
        line: ref.line,
        snippet: ref.snippet,
        reference: written,
        path: docPath,
        ...(operation ? { operation } : {}),
        detail,
        hint,
      });
    };

    let matched: string[] = [];
    for (const c of resolved.candidates) {
      const m = matchDocPath(c, templates);
      if (m.length > 0) {
        matched = m;
        docPath = c;
        break;
      }
    }

    if (matched.length === 0) {
      const near = closestTemplate(docPath, templates);
      emit(
        'unknown-endpoint',
        `no path in the spec matches ${docPath}`,
        near
          ? `Closest spec path: \`${METHODS.filter((m) => byPath.get(near)!.has(m)).join('|')} ${near}\`.`
          : 'No similar path in the spec; if this is another API, mark it with <!-- apibreak-ignore -->.'
      );
      continue;
    }

    const withMethod = matched.filter((t) => byPath.get(t)!.has(ref.method));
    if (withMethod.length === 0) {
      const allowed = new Set<Method>();
      for (const t of matched) for (const m of byPath.get(t)!.keys()) allowed.add(m);
      const ordered = METHODS.filter((m) => allowed.has(m));
      emit(
        'wrong-method',
        `${matched.join(' / ')} has no ${ref.method} operation`,
        `The spec allows ${ordered.join(', ')} on \`${matched[0]}\`.`,
        `${ordered.join('|')} ${matched[0]}`
      );
      continue;
    }
    // Two templates fit equally well; checking fields against either one would be a guess.
    if (withMethod.length > 1) continue;

    const template = withMethod[0]!;
    const op = byPath.get(template)!.get(ref.method)!;
    const opName = `${ref.method} ${template}`;

    // The templates above matched using every server base in the document
    // pooled together, which is right for deciding whether the HOST is one
    // the spec names at all, but wrong for deciding whether THIS operation
    // is the one that serves it: OpenAPI lets an operation (or its path
    // item) override `servers`, and an override elsewhere in the document
    // must never lend its host to an operation it does not cover. Re-resolve
    // the URL against only the bases that actually govern this operation
    // (its own override, else its path item's, else the document root —
    // Swagger 2.0's `host`/`basePath` is global and has no override) and
    // refuse the match if it does not hold up under that narrower set.
    // --base-url is the reader's own statement that a host (typically a local
    // or staging deployment) serves the whole API described by the spec, not
    // a per-operation fact drawn from the document — it must count for every
    // operation exactly as it already does for the coarser host check above,
    // regardless of what any operation's own `servers` override says.
    const ownBases = [...operationServerBases(spec.raw, op.pathItem, op.raw), ...baseUrlOverrides];
    const ownResolved = resolveUrl(ref.url, ownBases);
    const servedByThisOperation = ownResolved.kind === 'path' && ownResolved.candidates.some((c) => matchDocPath(c, [template]).length > 0);
    if (!servedByThisOperation) {
      const near = closestTemplate(docPath, templates);
      emit(
        'unknown-endpoint',
        `${docPath} is not served at this address by ${opName}; that address is only declared for a different operation's \`servers\``,
        near
          ? `Closest spec path: \`${METHODS.filter((m) => byPath.get(near)!.has(m)).join('|')} ${near}\`.`
          : `${opName} declares its own \`servers\`; check the URL against that host.`
      );
      continue;
    }

    if (op.deprecated) {
      emit('deprecated-operation', `${opName} is marked deprecated in the spec`, 'Point readers at the replacement operation, or drop the example.', opName);
    }

    // ---- query parameters ------------------------------------------------
    if (ref.queryUnread) {
      // Some part of the query string is a variable this check cannot read
      // (`params=<variable>`, a query built from `URLSearchParams`, …): it
      // might carry the very parameter a missing-required finding would
      // otherwise complain about, so no query finding is safe to make.
      result.queriesNotRead += 1;
    } else {
      const hasQuery = !!ref.query && ref.query.length > 0;
      // A required query parameter is worth flagging as missing even when
      // the example sends no query string at all — PROVIDED the example is
      // a complete one (fenced curl/HTTP/fetch/Python, where the whole URL
      // was parsed and its query, if any, was fully read) rather than an
      // inline `METHOD /path` mention in prose, which is routinely written
      // without a query string on purpose and is not meant to be a complete
      // example of the call.
      const checkMissingRequired = hasQuery || ref.source !== 'prose';
      if (checkMissingRequired) {
        const pv = parameters(op.raw, op.pathItem, spec.raw);
        if (pv.unknowns.length === 0) {
          const names = new Map<string, Json>();
          for (const k of queryKeyNames) names.set(k, {});
          let open = false;
          const required: string[] = [];
          for (const p of pv.params.values()) {
            if (p.location !== 'query') continue;
            // A form-style, exploded object parameter sends each of its
            // properties as its own query key — never the parameter's own
            // name, so it must not count as a required flat key either.
            const style = typeof p.raw?.style === 'string' ? p.raw.style : 'form';
            const explode = typeof p.raw?.explode === 'boolean' ? p.raw.explode : style === 'form';
            const sch = deref(p.schema, spec.raw);
            const sn = sch.ok ? sch.node : undefined;
            const isExplodedObject = style === 'form' && explode && !!sn && typeof sn === 'object' && (sn.type === 'object' || sn.properties);
            names.set(p.name, p.raw);
            if (p.required && !isExplodedObject) required.push(p.name);
            if (isExplodedObject) {
              const ps = objectProps(p.schema, spec.raw);
              if (ps.open || ps.unresolved) open = true;
              for (const [k, info] of ps.props) names.set(k, { deprecated: info.deprecated });
            }
          }
          // Swagger 2.0 formData parameters are not query parameters.
          if (!open && hasQuery) {
            for (const k of ref.query!) {
              if (names.has(k) || names.has(baseName(k)) || names.has(k.replace(/\[\]$/, ''))) continue;
              const near = closestName(baseName(k), names.keys());
              emit(
                'unknown-query-param',
                `query parameter "${k}" is not a parameter of ${opName}`,
                near ? `Did you mean \`${near}\`?` : `Query parameters in the spec: ${listNames(names.keys())}.`,
                opName
              );
            }
          }
          const sent = new Set((ref.query ?? []).map(baseName));
          const missing = required.filter((r) => !sent.has(r) && !(ref.query ?? []).includes(r));
          if (missing.length > 0) {
            emit(
              'missing-required',
              `omits required query parameter${missing.length === 1 ? '' : 's'} ${missing.map((m) => `"${m}"`).join(', ')}`,
              `Add ${listNames(missing)} to the example's query string.`,
              opName
            );
          }
          if (hasQuery) {
            for (const k of ref.query!) {
              const raw = names.get(k) ?? names.get(baseName(k));
              if (raw?.deprecated === true) {
                emit('deprecated-field', `query parameter "${k}" is marked deprecated in the spec`, 'Drop it from the example, or show its replacement.', opName);
              }
            }
          }
        }
      }
    }

    // ---- request body ----------------------------------------------------
    const body = ref.body;
    if (body) {
      if (body.keys === null) {
        result.bodiesNotRead += 1;
      } else {
        checkBody({ ...body, keys: body.keys }, op, spec, (rule, detail, hint) => emit(rule, detail, hint, opName), opName);
      }
    }
  }

  result.findings.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
  return result;
}

function checkBody(
  body: BodyRef & { keys: string[] },
  op: { raw: Json; pathItem: Json },
  spec: SpecDoc,
  emit: (rule: DocsRule, detail: string, hint: string) => void,
  opName: string
): void {
  const rb = op.raw?.requestBody;
  let media: Array<{ contentType: string; props: PropSet }> = [];

  if (rb === undefined || rb === null) {
    // Swagger 2.0 `formData` parameters stay parameters (load-spec.ts); they are this operation's body.
    const pv = parameters(op.raw, op.pathItem, spec.raw);
    if (pv.unknowns.length > 0) return;
    const formParams = [...pv.params.values()].filter((p) => p.location === 'formData');
    if (formParams.length === 0) {
      if (body.keys.length === 0) return;
      const queryNames = new Set([...pv.params.values()].filter((p) => p.location === 'query').map((p) => p.name));
      const asQuery = body.keys.filter((k) => queryNames.has(baseName(k)));
      emit(
        'unknown-body-field',
        `${opName} declares no request body, but the example sends ${listNames(body.keys)}`,
        asQuery.length === body.keys.length
          ? `The spec has ${listNames(asQuery)} as ${asQuery.length === 1 ? 'a query parameter' : 'query parameters'} of ${opName}; send ${asQuery.length === 1 ? 'it' : 'them'} in the query string.`
          : 'Remove the body, or check whether these moved to query parameters.'
      );
      return;
    }
    const props: PropSet = { props: new Map(), required: new Set(), open: false };
    for (const p of formParams) {
      props.props.set(p.name, { deprecated: p.raw?.deprecated === true, readOnly: false });
      if (p.required) props.required.add(p.name);
    }
    media = [{ contentType: 'application/x-www-form-urlencoded', props }, { contentType: 'multipart/form-data', props }];
  } else {
    const r = deref(rb, spec.raw);
    if (!r.ok || !r.node || typeof r.node !== 'object') return;
    const content = r.node.content;
    if (!content || typeof content !== 'object' || Array.isArray(content)) return;
    for (const [contentType, entry] of Object.entries(content as Record<string, Json>)) {
      const e = deref(entry, spec.raw);
      if (!e.ok) return;
      if (e.node?.schema === undefined) return; // a media type with no schema says nothing about fields
      media.push({ contentType, props: objectProps(e.node.schema, spec.raw) });
    }
    if (media.length === 0) return;
  }

  if (media.some((m) => m.props.unresolved)) return;

  // When the operation declares more than one media type, a JSON example's
  // fields are only meaningfully checked against the JSON (or `*+json`)
  // schema, and a form example's against the form-encoded schema — an
  // unrelated media type the vendor also lists (XML, say) says nothing about
  // what a JSON body may send, and merging it in would both hide a real
  // unknown field (it happens to also be a field of the other media type)
  // and manufacture one (a field the other media type does not happen to
  // have). The union of every media type is used only as a fallback, when
  // none of them matches this body's own encoding at all.
  const preferred = body.encoding === 'unknown' ? [] : media.filter((m) => BODY_MEDIA[body.encoding as Exclude<BodyRef['encoding'], 'unknown'>](m.contentType));
  const relevant = preferred.length > 0 ? preferred : media;

  // Unknown fields: a key no (relevant) media type lists, while none of them is open.
  if (!relevant.some((m) => m.props.open)) {
    const known = new Map<string, PropInfo>();
    for (const m of relevant) for (const [k, v] of m.props.props) if (!known.has(k)) known.set(k, v);
    for (const k of body.keys) {
      const name = body.encoding === 'json' ? k : baseName(k);
      if (known.has(name)) continue;
      const near = closestName(name, known.keys());
      emit(
        'unknown-body-field',
        `request body field "${name}" is not in the ${opName} request schema`,
        near ? `Did you mean \`${near}\`?` : `Fields in the spec: ${listNames(known.keys())}.`
      );
    }
  }

  // Deprecated fields, wherever the relevant media type(s) list them.
  for (const k of body.keys) {
    const name = body.encoding === 'json' ? k : baseName(k);
    if (relevant.some((m) => m.props.props.get(name)?.deprecated)) {
      emit('deprecated-field', `request body field "${name}" is marked deprecated in the spec`, 'Drop it from the example, or show its replacement.');
    }
  }

  // Missing required fields: only against the media type this example's encoding is, and only for a body read in full.
  if (!body.complete || body.encoding === 'unknown') return;
  const matching = preferred;
  if (matching.length !== 1) return;
  const sent = new Set(body.keys.map((k) => (body.encoding === 'json' ? k : baseName(k))));
  const missing = [...matching[0]!.props.required].filter((r) => !sent.has(r)).sort();
  if (missing.length > 0) {
    emit(
      'missing-required',
      `omits required request body field${missing.length === 1 ? '' : 's'} ${missing.map((m) => `"${m}"`).join(', ')}`,
      `Add ${listNames(missing)} to the example body (required by the spec).`
    );
  }
}
