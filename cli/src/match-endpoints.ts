/**
 * Matching the *same* operation across two documents when the wire URL is
 * identical but the spec's own naming of it moved. Three cosmetic edits are
 * treated as a match rather than a removal-plus-addition:
 *
 *   1. A path placeholder was renamed (`{id}` -> `{orderId}`).
 *   2. A trailing slash was added or dropped.
 *   3. The path prefix moved between `servers[].url` (OpenAPI 3) /
 *      `basePath` (Swagger 2) and the path templates themselves — including
 *      APIs.guru's synthetic `http://<x-providerName>` server, which is not
 *      the vendor's and must never set the prefix.
 *
 * The three are paired *before* the engine ever compares an operation, by
 * re-keying the new document's `paths` under the old document's templates
 * for the same wire URL. Pairing here — rather than diffing normally and
 * then suppressing the resulting `operation_removed` finding after the fact
 * — means the two operations are actually diffed against each other: a
 * placeholder rename that also drops a response field is a real
 * `response_field_removed` finding, not a silently dropped removal.
 *
 * None of this reinterprets a change the engine itself found inside a paired
 * operation — only whether two path templates name the same URL. When it is
 * not sure two operations are the same one, it does not guess.
 *
 * OpenAPI lets `servers` be overridden per operation or per path item, on top
 * of (or instead of) the root `servers`/`basePath` this module otherwise
 * reads the prefix from. Once any override exists anywhere in either
 * document, the prefix that governs one operation can no longer be answered
 * by "the document's own prefix" — different operations may sit at
 * different, independently-changing addresses. Rather than track that
 * per-operation (round 3's approach, and the source of a real false-positive
 * — a prefix-move realignment colliding with an unrelated override
 * elsewhere), this module now takes the simplest safe rule: an override
 * anywhere in EITHER document disables prefix-move realignment for the
 * WHOLE document. Matching then falls back to exact path-key text plus the
 * placeholder bijection (a rename is still recognised; a prefix that moved
 * is not chased). What each operation's own effective address actually is —
 * and whether it changed — is instead reported directly as a `server_changed`
 * finding (see `alignPaths`'s `serverChanged` result), which also makes sure
 * that operation's body and parameters are never compared as if nothing
 * about its address had changed.
 *
 * Two source paths can still, rarely, propose the same destination key (see
 * the `alignPaths` doc comment). Neither is ever merged into the other:
 * both keep their own literal key, and the pairing is reported as ambiguous
 * (see `ambiguous`) rather than silently read as an ordinary removal and
 * addition.
 */

import { deref, type Json } from './spec.js';

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** APIs.guru prepends a synthetic `http://<x-providerName>` server to the copies it stores. It is not the owner's. */
function isSyntheticServer(doc: Json, url: unknown): boolean {
  const provider = doc?.info?.['x-providerName'];
  return (
    typeof url === 'string' &&
    typeof provider === 'string' &&
    new RegExp(`^https?://${escapeRegExp(provider)}/?$`, 'i').test(url)
  );
}

/** A server URL with each `{variable}` replaced by its declared default ("x" when there is none). */
function expandServerUrl(server: Json): string {
  return String(server?.url ?? '').replace(/\{([^}]*)\}/g, (_: string, name: string) => {
    const d = server?.variables?.[name]?.default;
    return typeof d === 'string' ? d : 'x';
  });
}

/** The URL path component of a (variable-expanded) server URL, without a trailing slash. */
function serverUrlPath(url: string): string {
  let p = url
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '')
    .replace(/^\/\/[^/]*/, '')
    .replace(/[?#].*$/, '');
  if (p && !p.startsWith('/')) p = `/${p}`;
  return p.replace(/\/+$/, '');
}

/** The path prefix every operation sits under: OpenAPI 3 servers[0], Swagger 2 basePath. */
export function pathPrefix(doc: Json): string {
  let p = '';
  if (typeof doc?.basePath === 'string') {
    p = doc.basePath;
  } else if (Array.isArray(doc?.servers)) {
    // The synthetic APIs.guru server must not set the prefix.
    const server = (doc.servers as Json[]).find((s) => typeof s?.url === 'string' && !isSyntheticServer(doc, s.url)) ?? {
      url: '',
    };
    // Server variables take their declared default ({basePath} -> "/v2").
    p = serverUrlPath(expandServerUrl(server));
  }
  return p.replace(/\/+$/, '');
}

/**
 * Where an API says it lives: every server it declares, not just the first.
 * `host` is null for a relative server (`/v3`): it fixes a path prefix but
 * names no host, so it can never vouch for an absolute URL on its own.
 */
export interface ServerBase {
  /** Matches a URL's `host[:port]`, lowercased. Null for a relative server. */
  host: RegExp | null;
  /** The host as written, for messages. */
  hostLabel: string | null;
  /** URL path component, no trailing slash; '' at the root. */
  prefix: string;
}

/**
 * `host[:port]` as written (server variables allowed) → a matcher. A variable
 * matches any one DNS label run; a host written without a port matches it on
 * any port, because docs show `localhost:3000` against a spec that says
 * `localhost`, and the two are the same deployment far more often than not.
 */
export function hostMatcher(hostWritten: string): RegExp {
  const [name = '', port] = hostWritten.toLowerCase().split(/:(?=[^:]*$)/);
  const nameRe = name
    .split(/(\{[^}]*\})/)
    .map((part) => (/^\{[^}]*\}$/.test(part) ? '[^/]+' : escapeRegExp(part)))
    .join('');
  const portRe = port !== undefined && port !== '' && !/^\{/.test(port) ? `:${escapeRegExp(port)}` : '(?::\\d+)?';
  return new RegExp(`^${nameRe}${portRe}$`);
}

/** Every server base a document declares: root, path-item and operation `servers`, or Swagger 2.0 `host` + `basePath`. */
export function serverBases(doc: Json): ServerBase[] {
  const bases: ServerBase[] = [];
  const seen = new Set<string>();
  const add = (host: string | null, prefix: string): void => {
    const id = `${host ?? ''} ${prefix}`;
    if (seen.has(id)) return;
    seen.add(id);
    bases.push({ host: host ? hostMatcher(host) : null, hostLabel: host, prefix });
  };

  if (doc?.swagger === '2.0' || typeof doc?.basePath === 'string' || typeof doc?.host === 'string') {
    const prefix = typeof doc?.basePath === 'string' ? doc.basePath.replace(/\/+$/, '') : '';
    add(typeof doc?.host === 'string' && doc.host ? doc.host : null, prefix);
    return bases;
  }

  const addServers = (servers: Json): void => {
    if (!Array.isArray(servers)) return;
    for (const server of servers) {
      if (typeof server?.url !== 'string' || isSyntheticServer(doc, server.url)) continue;
      const raw = String(server.url);
      const hostMatch = /^(?:[a-z][a-z0-9+.-]*:)?\/\/([^/?#]*)/i.exec(raw);
      add(hostMatch ? hostMatch[1]! : null, serverUrlPath(expandServerUrl(server)));
    }
  };
  addServers(doc?.servers);
  const paths = doc?.paths;
  if (paths && typeof paths === 'object' && !Array.isArray(paths)) {
    for (const item of Object.values(paths as Record<string, Json>)) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      addServers(item.servers);
      for (const m of OP_METHODS) addServers(item[m]?.servers);
    }
  }
  if (bases.length === 0) add(null, '');
  return bases;
}

/**
 * The server bases that govern exactly ONE operation, respecting OpenAPI's
 * scoping rules: an operation's own `servers` entirely replaces everything
 * else for that operation; failing that, its path item's `servers` does the
 * same; failing that, the document root governs. Unlike `serverBases` (which
 * pools every override anywhere in the document into one flat list — right
 * for the coarse "does the spec know this host at all" question) this must
 * never let an override declared for a DIFFERENT operation lend its host to
 * one that does not have it: a URL on `https://other.test` is not reachable
 * at `GET /x` just because some unrelated `GET /y` happens to override its
 * own `servers` to `https://other.test`. Swagger 2.0's `host`/`basePath` has
 * no per-operation override and is always global, identical to `serverBases`.
 */
export function operationServerBases(doc: Json, pathItem: Json, op: Json): ServerBase[] {
  if (doc?.swagger === '2.0' || typeof doc?.basePath === 'string' || typeof doc?.host === 'string') {
    return serverBases(doc);
  }
  const own = ownServers(op) ?? ownServers(pathItem);
  const servers: Json[] = own ?? (Array.isArray(doc?.servers) ? (doc.servers as Json[]) : []);
  const bases: ServerBase[] = [];
  const seen = new Set<string>();
  for (const server of servers) {
    if (typeof server?.url !== 'string' || isSyntheticServer(doc, server.url)) continue;
    const raw = String(server.url);
    const hostMatch = /^(?:[a-z][a-z0-9+.-]*:)?\/\/([^/?#]*)/i.exec(raw);
    const host = hostMatch ? hostMatch[1]! : null;
    const prefix = serverUrlPath(expandServerUrl(server));
    const id = `${host ?? ''} ${prefix}`;
    if (seen.has(id)) continue;
    seen.add(id);
    bases.push({ host: host ? hostMatcher(host) : null, hostLabel: host, prefix });
  }
  return bases.length > 0 ? bases : [{ host: null, hostLabel: null, prefix: '' }];
}

/**
 * A path as documentation writes it, one entry per segment: `literal` text
 * (which also fits a template variable as a concrete value: `cus_123`, `42`,
 * `USER_ID`, `$id`), a `placeholder` for `{id}`, `{{id}}`, `:id`, `<id>` and
 * `${id}` — the spellings docs use for "put your value here" — or `mixed`
 * text around a placeholder (`{id}:cancel`).
 */
type DocSegment = { kind: 'literal'; text: string } | { kind: 'placeholder' } | { kind: 'mixed'; re: RegExp; filled: string };

const WHOLE_PLACEHOLDER = /^(?:\{\{[^}]*\}\}|\{[^}]*\}|<[^>]+>|\$\{[^}]*\}|:[A-Za-z_][A-Za-z0-9_-]*)$/;
const PLACEHOLDER_PART = /\{\{[^}]*\}\}|\{[^}]*\}|<[^>]+>|\$\{[^}]*\}/;

function docSegment(seg: string): DocSegment {
  if (WHOLE_PLACEHOLDER.test(seg)) return { kind: 'placeholder' };
  if (PLACEHOLDER_PART.test(seg)) {
    const parts = seg.split(new RegExp(PLACEHOLDER_PART.source, 'g')).map(escapeRegExp);
    return {
      kind: 'mixed',
      re: new RegExp(`^${parts.join('.+')}$`),
      filled: seg.replace(new RegExp(PLACEHOLDER_PART.source, 'g'), 'x'),
    };
  }
  return { kind: 'literal', text: seg };
}

/** How well one doc segment fits one template segment: 2 literal equality, 1 a placeholder fit, 0 no fit. */
function segmentScore(doc: DocSegment, tpl: string): number {
  const tplHasVar = /\{[^}]*\}/.test(tpl);
  if (doc.kind === 'literal') {
    if (doc.text === tpl) return 2;
    if (!tplHasVar) return 0;
    const re = new RegExp(`^${tpl.split(/\{[^}]*\}/).map(escapeRegExp).join('[^/]+')}$`);
    return re.test(doc.text) ? 1 : 0;
  }
  if (doc.kind === 'placeholder') {
    // A doc segment that is WHOLLY a placeholder (`{id}`) stands for "any
    // single value here" — it must only fit a template segment that is
    // itself wholly a variable (`{user_id}`), never one that mixes a
    // variable with literal text (`{id}.json`): `{id}` is not a value for
    // `{id}.json`, only for `{id}` itself. A doc segment that mixes literal
    // text with a placeholder (`{name}.json`) is handled separately below,
    // by shape, and is unaffected by this.
    return /^\{[^}]*\}$/.test(tpl) ? 1 : 0;
  }
  // A segment mixing literal text and a placeholder (`{id}:cancel`) fits a
  // template segment with the same literal text around its own variable, read
  // in either direction: `{name}.json` fits `{file}.{ext}`, `{id}:cancel` fits `{id}:cancel`.
  if (!tplHasVar) return 0;
  const tplRe = new RegExp(`^${tpl.split(/\{[^}]*\}/).map(escapeRegExp).join('.+')}$`);
  return doc.re.test(tpl.replace(/\{[^}]*\}/g, 'x')) || tplRe.test(doc.filled) ? 1 : 0;
}

const splitPath = (p: string): string[] => trimSlash(p).split('/').slice(1);

/**
 * The spec path template(s) a documented path names, best fit first: every
 * template with the same number of segments where each segment fits, scored
 * so a literal match (`/users/me`) beats a placeholder match (`/users/{id}`).
 * More than one template comes back only on an exact tie, and the caller must
 * not pick between them. A trailing slash on either side is ignored.
 */
export function matchDocPath(docPath: string, templates: Iterable<string>): string[] {
  const docSegs = splitPath(docPath).map(docSegment);
  let best = 0;
  let winners: string[] = [];
  for (const tpl of templates) {
    const tplSegs = splitPath(tpl);
    if (tplSegs.length !== docSegs.length) continue;
    let score = 0;
    let fits = true;
    for (let i = 0; i < tplSegs.length; i++) {
      const s = segmentScore(docSegs[i]!, tplSegs[i]!);
      if (s === 0) {
        fits = false;
        break;
      }
      score += s;
    }
    if (!fits) continue;
    // "/" has no segments and scores 0 against the root template; it still fits.
    if (winners.length === 0 || score > best) {
      best = score;
      winners = [tpl];
    } else if (score === best) {
      winners.push(tpl);
    }
  }
  return winners;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/** Edit distance between two names, for "did you mean" hints. */
export function nameDistance(a: string, b: string): number {
  return levenshtein(a, b);
}

/**
 * The template a reader most likely meant, for an "unknown endpoint" hint:
 * fewest differing segments first, then the smallest character distance with
 * placeholders blanked. Undefined when nothing is close enough to be a useful
 * suggestion rather than a random one.
 */
export function closestTemplate(docPath: string, templates: Iterable<string>): string | undefined {
  const docSegs = splitPath(docPath);
  const blank = (segs: string[]): string =>
    segs.map((s) => (docSegment(s).kind === 'literal' && !/\{[^}]*\}/.test(s) ? s : '{}')).join('/');
  const docBlank = blank(docSegs);
  let best: { tpl: string; segDiff: number; chars: number } | undefined;
  for (const tpl of templates) {
    const tplSegs = splitPath(tpl);
    const n = Math.max(tplSegs.length, docSegs.length);
    let segDiff = Math.abs(tplSegs.length - docSegs.length);
    for (let i = 0; i < Math.min(tplSegs.length, docSegs.length); i++) {
      if (segmentScore(docSegment(docSegs[i]!), tplSegs[i]!) === 0) segDiff += 1;
    }
    const chars = levenshtein(docBlank, blank(tplSegs));
    if (segDiff > Math.max(1, Math.floor(n / 2))) continue;
    if (!best || segDiff < best.segDiff || (segDiff === best.segDiff && chars < best.chars)) {
      best = { tpl, segDiff, chars };
    }
  }
  return best?.tpl;
}

const trimSlash = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, '') : p);
const blankPlaceholders = (p: string): string => p.replace(/\{[^}]*\}/g, '{}');

const OP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

/** The `{...}` placeholder names in a path template, in order of appearance. */
function placeholderNames(template: string): string[] {
  const names: string[] = [];
  const re = /\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template))) names.push(m[1] ?? '');
  return names;
}

type BijectionResult = { ok: true; renameMap: Map<string, string> | null } | { ok: false };

/**
 * Maps a new-side placeholder name to its old-side counterpart by POSITION —
 * the Nth `{...}` segment on one template names the same slot on the wire as
 * the Nth on the other, whatever either side calls it — but only when that
 * correspondence is a true bijection across every position: each old name
 * must map to exactly one new name and each new name to exactly one old
 * name, including where a name recurs on only one side (`/{a}/{b}` ->
 * `/{z}/{z}`: "z" would have to mean both "a" and "b" at once) or recurs on
 * both sides but inconsistently (`/{a}/{a}` -> `/{x}/{y}`: "a" would have to
 * rename to both "x" and "y"). Either conflict makes a positional rename
 * unsound — a rename works by NAME, so a repeated name renders two distinct
 * positions indistinguishable — and `ok: false` tells the caller to refuse
 * the cosmetic pairing entirely rather than guess which one is meant.
 *
 * `renameMap: null` in the ok case means the templates disagree on how many
 * placeholders there are (nothing sound to position-match, but also nothing
 * that looked like a conflict) or every position already agrees on its name.
 */
function placeholderBijection(oldTemplate: string, newTemplate: string): BijectionResult {
  const oldNames = placeholderNames(oldTemplate);
  const newNames = placeholderNames(newTemplate);
  if (oldNames.length !== newNames.length || oldNames.length === 0) return { ok: true, renameMap: null };

  const newToOld = new Map<string, string>();
  const oldToNew = new Map<string, string>();
  for (let i = 0; i < newNames.length; i++) {
    const oldName = oldNames[i]!;
    const newName = newNames[i]!;
    const existingOld = newToOld.get(newName);
    if (existingOld !== undefined && existingOld !== oldName) return { ok: false };
    newToOld.set(newName, oldName);
    const existingNew = oldToNew.get(oldName);
    if (existingNew !== undefined && existingNew !== newName) return { ok: false };
    oldToNew.set(oldName, newName);
  }

  const renameMap = new Map<string, string>();
  for (const [newName, oldName] of newToOld) {
    if (newName !== oldName) renameMap.set(newName, oldName);
  }
  return { ok: true, renameMap: renameMap.size > 0 ? renameMap : null };
}

/**
 * Renames every `in: path` entry in a `parameters` array whose current name
 * is a key in `renameMap`, resolving a `$ref` entry first (a vendor may
 * declare the shared path parameter once in `components` and `$ref` it from
 * several operations). A non-path entry, an entry whose name is not in the
 * map, and an entry that fails to resolve are all left untouched.
 */
function renameParamList(list: Json, renameMap: Map<string, string>, doc: Json): Json {
  if (!Array.isArray(list)) return list;
  let changed = false;
  const next = list.map((entry: Json) => {
    const resolved = deref(entry, doc);
    if (!resolved.ok) return entry;
    const p = resolved.node;
    if (!p || typeof p !== 'object' || Array.isArray(p) || p.in !== 'path' || typeof p.name !== 'string') return entry;
    const oldName = renameMap.get(p.name);
    if (oldName === undefined) return entry;
    changed = true;
    return { ...p, name: oldName };
  });
  return changed ? next : list;
}

/** Applies `renameParamList` to a path item's own `parameters` and every operation's. */
function renamePathParamsInItem(item: Json, renameMap: Map<string, string>, doc: Json): Json {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  let changed = false;
  const next: Record<string, Json> = { ...item };
  const itemParams = renameParamList(item.parameters, renameMap, doc);
  if (itemParams !== item.parameters) {
    next.parameters = itemParams;
    changed = true;
  }
  for (const m of OP_METHODS) {
    const op = item[m];
    if (op && typeof op === 'object' && !Array.isArray(op)) {
      const opParams = renameParamList(op.parameters, renameMap, doc);
      if (opParams !== op.parameters) {
        next[m] = { ...op, parameters: opParams };
        changed = true;
      }
    }
  }
  return changed ? next : item;
}

export interface AlignResult {
  doc: Json;
  /** How many new paths were re-keyed under the old document's template for the same wire URL. */
  moved: number;
  /**
   * `"METHOD key"` (uppercase method, the key as it appears in the returned
   * doc, or the old document, whichever side it is on) for every operation
   * that was caught in a destination-key collision: two source path items
   * proposed the same destination and neither could be confidently paired.
   * Both keep their own literal key rather than being merged; the caller
   * must report these `unknown` and must not compare them as an ordinary
   * pair or as an ordinary removal-and-addition.
   */
  ambiguous: Set<string>;
  /**
   * `"METHOD key"` for every operation, present under the same key on both
   * sides, whose effective server address (operation > path item > root,
   * compared as just the URL path component) differs between the two
   * documents. The caller must report these `server_changed` and must not
   * compare their body or parameters.
   */
  serverChanged: Set<string>;
  /**
   * `"METHOD key"` -> `"METHOD key"`, in both directions, for every pair of
   * operations that are each unmatched on their own side but would have
   * paired under an ordinary root-prefix move (the same tiered match
   * `matchTier` runs for the normal case) — computed even though
   * `skipRealignment` refused to actually re-key anything, because some
   * OTHER part of the document has its own `servers` override. The caller
   * must report each such pair as ONE `possibly_moved`/`unknown` finding,
   * never as an ordinary removal on one side plus an ordinary addition on
   * the other. Always empty when realignment ran normally (nothing here is
   * "possible" — a normal run either pairs an operation outright or leaves
   * it an ordinary removal/addition).
   */
  possiblyMoved: Map<string, string>;
  /**
   * Set when the document-root server path differs (`/v3` -> `/api/v3`) and
   * at least one path template that no wire match explained was paired with
   * the identical template on the old side. Every such operation's URL
   * changed with the root; the caller reports that once, not per operation,
   * and compares the paired operations as the same operations.
   */
  rootPrefixChanged?: { from: string; to: string; paired: number };
}

/** A path-item or operation node's own `servers` override, or null. */
function ownServers(node: Json): Json[] | null {
  return node && typeof node === 'object' && !Array.isArray(node) && Array.isArray(node.servers) && node.servers.length > 0
    ? (node.servers as Json[])
    : null;
}

/** Does any path item or operation in this document declare its own `servers`? Root-level `servers`/`basePath` do not count. */
function hasServersOverride(doc: Json): boolean {
  const paths = doc?.paths;
  if (!paths || typeof paths !== 'object' || Array.isArray(paths)) return false;
  for (const item of Object.values(paths as Record<string, Json>)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (ownServers(item) !== null) return true;
    for (const m of OP_METHODS) {
      if (ownServers(item[m]) !== null) return true;
    }
  }
  return false;
}

/** The effective server URL path component governing one operation: operation > path item > document root. */
function effectiveServerPath(op: Json, item: Json, rootDoc: Json): string {
  const servers = ownServers(op) ?? ownServers(item);
  return servers ? pathPrefix({ servers }) : pathPrefix(rootDoc);
}

interface OldIndex {
  /** wire key -> the one old path with that key. Absent when more than one old path shares it. */
  map: Map<string, string>;
  /** wire keys more than one old path produced — never a match target. */
  ambiguous: Set<string>;
}

/** Indexes old paths by a wire-key transform, never overwriting a candidate silently. */
function buildOldIndex(oldPaths: ReadonlyMap<string, Json>, oldPrefix: string, transform: (wire: string) => string): OldIndex {
  const map = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const o of oldPaths.keys()) {
    const key = transform(oldPrefix + o);
    if (map.has(key) && map.get(key) !== o) {
      ambiguous.add(key);
      continue;
    }
    map.set(key, o);
  }
  return { map, ambiguous };
}

/** How many new paths produce a given wire-key transform — a match is only trustworthy when it is unique on the new side too. */
function buildNewCounts(newPaths: ReadonlyMap<string, Json>, newPrefix: string, transform: (wire: string) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const p of newPaths.keys()) {
    const key = transform(newPrefix + p);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

interface Proposal {
  /** The new document's own literal path text this came from. */
  originPath: string;
  item: Json;
  /** The key this proposal wants to land at: an old template, or `originPath` itself when unmatched. */
  destKey: string;
  moved: boolean;
  /** Paired with the identical old template after the root server path changed (see `matchTier`). */
  literalPaired?: boolean;
}

/**
 * Runs the three-tier match (exact wire / trailing-slash-normalized /
 * placeholder-blanked) once, for the whole document. `used` guarantees a
 * given old key is claimed by at most one new path within this single call —
 * the invariant that makes a *matched* destKey collision-free by
 * construction; see the `alignPaths` doc comment for the one way a
 * collision can still happen.
 */
function matchTier(
  oldPaths: ReadonlyMap<string, Json>,
  newPaths: ReadonlyMap<string, Json>,
  oldPrefix: string,
  newPrefix: string,
  prefixMoved: boolean,
  newDocForRefs: Json
): Proposal[] {
  const exactT = (w: string): string => w;
  const normT = (w: string): string => trimSlash(w);
  const placeholderT = (w: string): string => trimSlash(blankPlaceholders(w));

  const oldExact = prefixMoved ? buildOldIndex(oldPaths, oldPrefix, exactT) : null;
  const newExactCounts = prefixMoved ? buildNewCounts(newPaths, newPrefix, exactT) : null;
  const oldNorm = prefixMoved ? buildOldIndex(oldPaths, oldPrefix, normT) : null;
  const newNormCounts = prefixMoved ? buildNewCounts(newPaths, newPrefix, normT) : null;
  const oldPlaceholder = buildOldIndex(oldPaths, oldPrefix, placeholderT);
  const newPlaceholderCounts = buildNewCounts(newPaths, newPrefix, placeholderT);

  const tryTier = (key: string, index: OldIndex | null, counts: Map<string, number> | null, used: Set<string>): string | undefined => {
    if (!index || !counts) return undefined;
    if (index.ambiguous.has(key)) return undefined;
    const o = index.map.get(key);
    if (o === undefined || used.has(o)) return undefined;
    if ((counts.get(key) ?? 0) !== 1) return undefined;
    return o;
  };

  const used = new Set<string>();
  const proposals: Proposal[] = [];
  /** Proposals left unmatched by every wire tier while the prefix moved; settled after the loop. */
  const unsettled: Proposal[] = [];

  for (const [p, item] of newPaths) {
    const wire = newPrefix + p;
    let matched =
      tryTier(exactT(wire), oldExact, newExactCounts, used) ??
      tryTier(normT(wire), oldNorm, newNormCounts, used) ??
      tryTier(placeholderT(wire), oldPlaceholder, newPlaceholderCounts, used);

    let renameMap: Map<string, string> | null = null;
    if (matched !== undefined && matched !== p) {
      // A cosmetic pairing may still rename placeholders position-for-
      // position, but only when that correspondence is unambiguous (see
      // `placeholderBijection`). A repeated placeholder name that maps to
      // more than one counterpart on the other side cannot be renamed by
      // name at all — refuse the cosmetic pairing entirely rather than
      // guess which occurrence is meant, exactly like an ambiguous wire key
      // is never used as a match target above.
      const bijection = placeholderBijection(matched, p);
      if (!bijection.ok) {
        matched = undefined;
      } else {
        renameMap = bijection.renameMap;
      }
    }

    if (matched !== undefined) {
      used.add(matched);
      let storedItem = item;
      if (matched !== p && renameMap) {
        // A placeholder rename ("{id}" -> "{orderId}") pairs the two path
        // templates, but leaves each operation's own "in: path" parameter
        // declared under its own side's name. Reconcile them positionally
        // so the engine compares the SAME parameter instead of reporting
        // the new name as newly added (and, being a path parameter,
        // required) with no old-side counterpart.
        storedItem = renamePathParamsInItem(item, renameMap, newDocForRefs);
      }
      proposals.push({ originPath: p, item: storedItem, destKey: matched, moved: matched !== p });
    } else if (prefixMoved) {
      const prop: Proposal = { originPath: p, item, destKey: p, moved: false };
      proposals.push(prop);
      unsettled.push(prop);
    } else {
      proposals.push({ originPath: p, item, destKey: p, moved: false });
    }
  }

  // The root prefix differs and no wire tier matched these new paths. Settled
  // only after every wire match has claimed its old key, so a literal pairing
  // below can never take an old key a later wire match needed.
  //
  //   - The identical template exists on the old side and nothing claimed it:
  //     the root server path itself changed (`/v3` -> `/api/v3`) with the
  //     paths left alone. Paired by template, and flagged so the caller
  //     reports the server change once (`literalPaired`). Before this, such a
  //     path got the synthetic key below, which `indexSpec` never indexes,
  //     and a spec whose every path was unmatched read as "declares no
  //     operations": every endpoint came out `unknown`.
  //   - No old path has this template: it keeps its own key, an ordinary
  //     addition no old operation can be confused with.
  //   - The template exists on the old side but another new path's wire match
  //     already claimed it: a synthetic key no real template spells (it still
  //     starts with "/" so the operation is indexed and counted as added),
  //     so an unrelated new path is never compared against the wrong old one.
  for (const prop of unsettled) {
    const p = prop.originPath;
    if (oldPaths.has(p) && !used.has(p)) {
      used.add(p);
      prop.literalPaired = true;
    } else if (oldPaths.has(p)) {
      prop.destKey = `${UNPAIRED_KEY_PREFIX}${newPrefix}${p}`;
    }
  }
  return proposals;
}

/** Prefix of the synthetic key an unpairable new path is parked under; no real path template starts with it. */
export const UNPAIRED_KEY_PREFIX = '/[wire]';

/** Every method a path item declares, as `"METHOD key"` strings. */
function addOperationKeys(item: Json, key: string, out: Set<string>): void {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return;
  for (const m of OP_METHODS) {
    const op = item[m];
    if (op && typeof op === 'object' && !Array.isArray(op)) out.add(`${m.toUpperCase()} ${key}`);
  }
}

/**
 * Re-expresses the new document's path keys under the old document's
 * templates for the same operation, so the engine compares the same
 * operations instead of reporting a cosmetic edit as a removal-plus-addition.
 *
 * When neither document declares a `servers` override anywhere (see
 * `hasServersOverride`), matching runs the full three-tier match against the
 * document's own root prefix, exactly as if there were no overrides at all.
 * The moment either document has one, this module no longer trusts itself to
 * know each operation's real address well enough to move anything: matching
 * falls back to exact path-key text plus the placeholder bijection only (no
 * prefix is assumed to have moved). What actually changed about an
 * operation's own address is instead reported per-operation as
 * `server_changed` (see `AlignResult`).
 *
 * A single pass of `matchTier` for the whole document means a *matched*
 * destination can never collide with another *matched* one — `used`
 * guarantees that. A collision can still happen between a matched proposal
 * and an unrelated new path that simply happens to be spelled the way an old
 * template reads, when the unrelated path is processed later in document
 * order and so cannot claim that text for itself first (`used` is checked in
 * one pass, in the order the new document declares its paths — an ordering a
 * vendor controls, not this module). Neither wins: both fall back to their
 * own literal key, and every operation on both sides of the collision — the
 * old operation at the contested key and every new origin that proposed it —
 * is reported in `ambiguous` rather than silently read as a clean pair or a
 * clean removal-and-addition.
 */
export function alignPaths(oldDoc: Json, newDoc: Json): AlignResult {
  const oldPrefix = pathPrefix(oldDoc);
  const newPrefix = pathPrefix(newDoc);
  const oldPathsRaw: Record<string, Json> = oldDoc?.paths && typeof oldDoc.paths === 'object' ? oldDoc.paths : {};
  const newPathsRaw: Record<string, Json> = newDoc?.paths && typeof newDoc.paths === 'object' ? newDoc.paths : {};
  const oldPaths = new Map(Object.entries(oldPathsRaw));
  const newPaths = new Map(Object.entries(newPathsRaw));

  const skipRealignment = hasServersOverride(oldDoc) || hasServersOverride(newDoc);
  const effOldPrefix = skipRealignment ? '' : oldPrefix;
  const effNewPrefix = skipRealignment ? '' : newPrefix;
  const prefixMoved = !skipRealignment && oldPrefix !== newPrefix;

  const proposals = matchTier(oldPaths, newPaths, effOldPrefix, effNewPrefix, prefixMoved, newDoc);

  // Reserve destinations: more than one distinct origin path proposing the
  // same destKey is a collision. Every contributing proposal falls back to
  // its own literal key — never merged — and every operation involved, on
  // both sides, is marked ambiguous.
  const byDestKey = new Map<string, Proposal[]>();
  for (const prop of proposals) {
    let list = byDestKey.get(prop.destKey);
    if (!list) {
      list = [];
      byDestKey.set(prop.destKey, list);
    }
    list.push(prop);
  }

  const ambiguous = new Set<string>();
  for (const [destKey, list] of byDestKey) {
    const origins = new Set(list.map((p) => p.originPath));
    if (origins.size <= 1) continue;
    const oldItem = oldPaths.get(destKey);
    if (oldItem !== undefined) addOperationKeys(oldItem, destKey, ambiguous);
    for (const prop of list) {
      prop.destKey = prop.originPath;
      prop.moved = false;
      addOperationKeys(prop.item, prop.originPath, ambiguous);
    }
  }

  // Post-backoff, every proposal's destKey is unique: a matched proposal
  // never collides with another matched one (the `used` set inside
  // `matchTier` already guarantees that), and every proposal that WAS part
  // of a collision was just reset to its own — inherently unique — origin
  // key above. One item per destination key, safely.
  let moved = 0;
  let changed = false;
  const paths: Record<string, Json> = {};
  for (const prop of proposals) {
    paths[prop.destKey] = prop.item;
    if (prop.moved) moved += 1;
    if (prop.destKey !== prop.originPath) changed = true;
  }

  // `server_changed`: for every key present in both the old document and the
  // final (post-alignment) new paths, compare each method's effective
  // server address. Skipped where the pairing is itself ambiguous — an
  // operation whose very pairing is uncertain has nothing sound to compare
  // its address against.
  //
  // Only computed when realignment was SKIPPED (`skipRealignment`). When
  // realignment ran normally, a root-level prefix move is exactly what it
  // already normalized away — re-flagging that same prefix delta here as
  // `server_changed` would contradict the pairing alignPaths just made and
  // suppress the ordinary field-level diff a plain prefix move is supposed
  // to get. `server_changed` exists for the case realignment refused to run
  // (a path-item/operation override was present somewhere), where the
  // effective address is the only thing left that can be compared at all.
  const serverChanged = new Set<string>();
  if (skipRealignment) {
    for (const [destKey, item] of Object.entries(paths)) {
      const oldItem = oldPaths.get(destKey);
      if (oldItem === undefined || !oldItem || typeof oldItem !== 'object' || Array.isArray(oldItem)) continue;
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      for (const m of OP_METHODS) {
        const opOld = oldItem[m];
        const opNew = item[m];
        if (!opOld || typeof opOld !== 'object' || Array.isArray(opOld)) continue;
        if (!opNew || typeof opNew !== 'object' || Array.isArray(opNew)) continue;
        const key = `${m.toUpperCase()} ${destKey}`;
        if (ambiguous.has(key)) continue;
        const oldPath = effectiveServerPath(opOld, oldItem, oldDoc);
        const newPath = effectiveServerPath(opNew, item, newDoc);
        if (oldPath !== newPath) serverChanged.add(key);
      }
    }
  }

  // `possiblyMoved`: only meaningful when realignment was SKIPPED — when it
  // ran normally, a root-prefix move is exactly what it already paired, so
  // there is nothing left "possible" to report. Restricted to operations
  // that are unmatched on BOTH sides after the ordinary (non-prefix-moving)
  // pass above.
  //
  // Matching is done per (path, METHOD), not per whole path item. A path
  // item's methods do not necessarily all move together: one method may
  // have its own `servers` override, making ITS true effective address
  // independent of the document's root prefix entirely, while a sibling
  // method on the very same item follows the root move normally. Pairing
  // whole items first and then sweeping every method they both happen to
  // declare (the earlier approach) would drag an unrelated, unmoved method
  // into another method's root-prefix pairing just because they share a
  // path template. Each method's own candidate wire is therefore built from
  // its OWN effective server path (operation > item > document root, same
  // precedence `serverChanged` already uses) plus its item's raw path text,
  // and only a method whose wire is unique on both sides and matches
  // exactly is paired.
  const possiblyMoved = new Map<string, string>();
  if (skipRealignment) {
    const matchedOldKeys = new Set<string>();
    for (const prop of proposals) {
      if (oldPaths.has(prop.destKey)) matchedOldKeys.add(prop.destKey);
    }
    const unmatchedOld = new Map<string, Json>();
    for (const [key, item] of oldPaths) {
      if (!matchedOldKeys.has(key)) unmatchedOld.set(key, item);
    }
    const unmatchedNew = new Map<string, Json>();
    for (const prop of proposals) {
      if (!oldPaths.has(prop.destKey)) unmatchedNew.set(prop.originPath, prop.item);
    }

    interface MethodEntry {
      key: string;
      method: (typeof OP_METHODS)[number];
      wire: string;
    }
    const collectEntries = (items: ReadonlyMap<string, Json>, rootDoc: Json): MethodEntry[] => {
      const entries: MethodEntry[] = [];
      for (const [key, item] of items) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        for (const m of OP_METHODS) {
          const op = item[m];
          if (!op || typeof op !== 'object' || Array.isArray(op)) continue;
          const wire = trimSlash(blankPlaceholders(effectiveServerPath(op, item, rootDoc) + key));
          entries.push({ key, method: m, wire });
        }
      }
      return entries;
    };
    const oldEntries = collectEntries(unmatchedOld, oldDoc);
    const newEntries = collectEntries(unmatchedNew, newDoc);

    const byWire = <K extends MethodEntry>(entries: K[]): Map<string, K[]> => {
      const map = new Map<string, K[]>();
      for (const e of entries) {
        const list = map.get(e.wire);
        if (list) list.push(e);
        else map.set(e.wire, [e]);
      }
      return map;
    };
    const oldByWire = byWire(oldEntries);
    const newByWire = byWire(newEntries);

    for (const [wire, oldList] of oldByWire) {
      if (oldList.length !== 1) continue; // not unique on the old side — no confident pairing
      const newList = newByWire.get(wire);
      if (!newList || newList.length !== 1) continue; // absent, or not unique, on the new side
      const oldE = oldList[0]!;
      const newE = newList[0]!;
      if (oldE.method !== newE.method) continue;
      const oldOpKey = `${oldE.method.toUpperCase()} ${oldE.key}`;
      const newOpKey = `${newE.method.toUpperCase()} ${newE.key}`;
      possiblyMoved.set(oldOpKey, newOpKey);
      possiblyMoved.set(newOpKey, oldOpKey);
    }
  }

  const literalPaired = proposals.filter((prop) => prop.literalPaired && prop.destKey === prop.originPath).length;
  const rootPrefixChanged = literalPaired > 0 ? { from: oldPrefix, to: newPrefix, paired: literalPaired } : undefined;
  const extra = rootPrefixChanged ? { rootPrefixChanged } : {};

  if (!changed) return { doc: newDoc, moved: 0, ambiguous, serverChanged, possiblyMoved, ...extra };
  return { doc: { ...newDoc, paths }, moved, ambiguous, serverChanged, possiblyMoved, ...extra };
}
