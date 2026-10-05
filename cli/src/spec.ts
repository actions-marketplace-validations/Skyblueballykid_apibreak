/**
 * Reading an OpenAPI document far enough to compare two of them, and no further.
 *
 * This is not a validator and not a full resolver. It answers a handful of
 * questions about one operation — does it exist, is it deprecated, what may a
 * caller send, what does a success response contain — and it records `unknown`
 * the moment a construct is outside what it can answer honestly.
 *
 * Three decisions here are load-bearing, and all three exist because a monitor
 * that misses a breaking change is worse than no monitor at all:
 *
 *   - **Shapes are flattened, not skimmed.** A field lives at a dotted path
 *     (`data.items[].id`), so removing a field three levels down is visible.
 *     An earlier version compared only top-level property names, which meant a
 *     removed `response.data.id` read as a clean run.
 *   - **Every alternative is read, not just the first.** All 2xx statuses and
 *     all media types are indexed, because a vendor who leaves `200` alone and
 *     empties `201`, or leaves JSON alone and changes multipart, has still
 *     broken somebody.
 *   - **`allOf` is intersected; `anyOf`/`oneOf` is refused.** An intersection
 *     is unambiguous. A union is not: a field required in one branch and
 *     absent in another cannot be compared without inventing an answer, so it
 *     becomes `unknown` at that path rather than a guess in either direction.
 *     Two `allOf` branches that define the same field differently are the same
 *     kind of ambiguity and get the same treatment.
 *
 * What the vendor does not enumerate cannot be compared: a free-form
 * `{ "type": "object" }` has no fields to remove, so such a path is marked
 * opaque. Opaque is not silence — the diff reports when a parent stops
 * enumerating fields it used to list, rather than announcing that all of them
 * were removed.
 */

import { METHODS, type EndpointRef } from './types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
/** A node of a vendor document. Fetched from the public internet; assume nothing. */
export type Json = any;

export interface Operation {
  raw: Json;
  /** The path item the operation sits in. Path-level parameters are inherited from it. */
  pathItem: Json;
  deprecated: boolean;
}

export interface SpecDoc {
  raw: Json;
  /** `POST /v1/payment_intents` → operation. */
  operations: Map<string, Operation>;
  /** The vendor's own version string, when it publishes one. */
  version?: string;
  /**
   * Set when the document could not be read as an OpenAPI description at all.
   * The diff turns this into `unknown` for every declared endpoint. Without it
   * a truncated or error-page response would index zero operations and every
   * endpoint would be reported as removed.
   */
  unreadable?: string;
}

export function endpointKey(e: EndpointRef): string {
  return `${e.method} ${e.path}`;
}

/** Keys a Path Item Object owns itself, as opposed to a schema's structural keywords. */
const PATH_ITEM_OWN_KEYS = new Set([...METHODS.map((m) => m.toLowerCase()), 'parameters', 'servers']);

export function indexSpec(raw: Json): SpecDoc {
  const operations = new Map<string, Operation>();
  const version = typeof raw?.info?.version === 'string' ? raw.info.version : undefined;

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { raw, operations, version, unreadable: 'the specification is not a JSON object' };
  }
  const paths = raw.paths;
  if (!paths || typeof paths !== 'object' || Array.isArray(paths)) {
    return { raw, operations, version, unreadable: 'the specification has no `paths` object' };
  }

  for (const [path, rawItem] of Object.entries(paths as Record<string, Json>)) {
    // The Paths Object allows `x-` extensions alongside path templates; an
    // extension's value is vendor metadata, not a path item, even when it
    // happens to be shaped like `{"$ref": ...}`.
    if (!path.startsWith('/')) continue;
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) continue;

    let pathItem: Json = rawItem;
    if (typeof rawItem.$ref === 'string') {
      // OpenAPI 3.1 allows a path item to be written as a standalone `$ref`
      // to a `components.pathItems` entry, with no method keys on the node
      // itself. Reading methods off the un-dereferenced node would see none
      // of them, and the diff would report every operation under this path
      // as removed.
      const resolved = deref(rawItem, raw, new Set(), 0, PATH_ITEM_OWN_KEYS);
      if (!resolved.ok) {
        return {
          raw,
          operations,
          version,
          unreadable: `the path item "${path}" could not be resolved: ${resolved.reason}`,
        };
      }
      if (!resolved.node || typeof resolved.node !== 'object' || Array.isArray(resolved.node)) {
        return {
          raw,
          operations,
          version,
          unreadable: `the path item "${path}" could not be resolved: it does not resolve to an object`,
        };
      }
      pathItem = resolved.node;
    }

    for (const method of METHODS) {
      const op = pathItem[method.toLowerCase()];
      // An array or a scalar where an operation belongs is malformed. Skipping
      // it here means the endpoint is absent, which the diff reports; treating
      // it as an operation would crash later on a shape read.
      if (!op || typeof op !== 'object' || Array.isArray(op)) continue;
      operations.set(`${method} ${path}`, { raw: op, pathItem, deprecated: op.deprecated === true });
    }
  }

  if (operations.size === 0) {
    return { raw, operations, version, unreadable: 'the specification declares no operations' };
  }
  return { raw, operations, version };
}

const MAX_REF_DEPTH = 8;
/** How deep into nested objects and arrays fields are flattened before the reader stops and says so. */
export const MAX_SHAPE_DEPTH = 8;

export type DerefResult = { ok: true; node: Json } | { ok: false; reason: string };

/**
 * Keys that shape the value a schema accepts. A `$ref` sharing a node with one
 * of these is JSON Schema 2019-09+ semantics (OpenAPI 3.1: siblings apply
 * alongside the target); OpenAPI 3.0 says siblings are ignored. This reader
 * does not merge them, and following the ref
 * and dropping the siblings would silently ignore half of what the vendor
 * published. Non-structural siblings (`description`, `title`, `x-*`, …) are
 * annotations and are ignored, as every OpenAPI 3.1 document in the wild expects.
 */
const STRUCTURAL_SIBLINGS = new Set([
  'properties',
  'items',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'required',
  'additionalProperties',
  'patternProperties',
  'type',
  'enum',
  'const',
  'dependentSchemas',
  'dependentRequired',
  'if',
  'then',
  'else',
  'prefixItems',
  'contains',
  'propertyNames',
  'unevaluatedProperties',
  'unevaluatedItems',
]);

/**
 * Follows local `$ref`s. A remote, circular, missing or over-deep reference is
 * an explicit failure rather than `undefined`, because the caller has to be
 * able to tell "resolved to nothing" from "could not resolve" — the first is a
 * comparison, the second is an `unknown`.
 *
 * A `$ref` that shares its node with a structural keyword (`properties`,
 * `type`, `required`, …) is refused rather than followed-with-siblings-dropped:
 * the caller compares single schemas, and merging a ref into its siblings is
 * the one thing it has not been taught to do. The check runs at the node the
 * caller passed in and again at each hop of the chain. A caller with its own
 * notion of "sibling" — a path item's own `get`, `parameters`, `servers` are
 * not schema keywords but are just as unmergeable — passes `refuseSiblings`
 * to extend that refusal, checked at every hop alongside the built-in set.
 */
export function deref(
  node: Json,
  doc: Json,
  seen: Set<string> = new Set(),
  depth = 0,
  refuseSiblings?: ReadonlySet<string>
): DerefResult {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return { ok: true, node };
  const ref = node.$ref;
  if (typeof ref !== 'string') return { ok: true, node };
  const siblings = Object.keys(node)
    .filter((k) => k !== '$ref' && (STRUCTURAL_SIBLINGS.has(k) || refuseSiblings?.has(k)))
    .sort();
  if (siblings.length > 0) {
    return {
      ok: false,
      reason: `"${ref}" has sibling keywords (${siblings.join(', ')}) that this check does not merge`,
    };
  }
  if (depth >= MAX_REF_DEPTH) return { ok: false, reason: `a $ref chain runs deeper than ${MAX_REF_DEPTH} links` };
  // Locality is decided on the RAW ref text, before any decoding: does it
  // start with `#` at all? A ref that does not is remote and refused
  // outright, exactly as before. A validly percent-encoded local ref can
  // itself start with something other than a literal `#/` — e.g.
  // `#%2Fcomponents%2Fschemas%2FX` decodes to `#/components/schemas/X` — so
  // pointer *shape* (does it look like `#/...`) is judged only AFTER
  // decoding, never before; judging it on the raw, still-encoded text would
  // incorrectly refuse a validly encoded local ref.
  if (!ref.startsWith('#')) return { ok: false, reason: `"${ref}" points outside this document` };
  if (seen.has(ref)) return { ok: false, reason: `"${ref}" is circular` };
  seen.add(ref);

  // A `$ref` is a URI fragment (RFC 6901 §6): the JSON Pointer string is
  // built first (with `~1`/`~0` escaping), and THEN the whole result is
  // percent-encoded for use in a URI fragment — so a character reserved in a
  // URI (`{`, `}`, a space, and in principle even the pointer's own `/`
  // separators) can end up percent-encoded. Recovering the pointer runs
  // those two steps in reverse: percent-decode the fragment AS A WHOLE
  // first, and only then split it on `/` and unescape `~1`/`~0` per token.
  // Decoding each already-split segment on its own (as this used to) gives
  // the same answer when only inner characters like `{`/`}` are encoded
  // (real vendor documents do this, e.g.
  // `#/paths/~1companies~1%7BcompanyId%7D~1x/parameters/0`), but is wrong
  // when a structural `/` itself was percent-encoded as `%2F` — there is
  // then no literal `/` left to split on until the fragment is decoded
  // first. A malformed percent sequence is refused outright, as an explicit,
  // named failure — never silently resolved against the raw, undecoded text,
  // which could resolve to the wrong node instead of refusing.
  const pointer = ref.slice(1);
  let decodedPointer: string;
  try {
    decodedPointer = decodeURIComponent(pointer);
  } catch {
    return { ok: false, reason: `"${ref}" has malformed percent-encoding and cannot be decoded` };
  }

  // Only NOW, once the fragment is fully decoded, is its pointer shape
  // validated: empty (the ref is just `#`, the whole document) or starting
  // with `/` (an RFC 6901 pointer). Anything else is not a JSON pointer at
  // all and is refused.
  if (decodedPointer !== '' && !decodedPointer.startsWith('/')) {
    return { ok: false, reason: `"${ref}" is not a valid JSON pointer` };
  }

  let cur: Json = doc;
  if (decodedPointer !== '') {
    for (const rawSeg of decodedPointer.slice(1).split('/')) {
      const seg = rawSeg.replace(/~1/g, '/').replace(/~0/g, '~');
      if (!cur || typeof cur !== 'object') return { ok: false, reason: `"${ref}" does not resolve` };
      // Own properties only. `#/__proto__` would otherwise resolve to
      // Object.prototype and be compared as if the vendor had published it.
      if (!Object.prototype.hasOwnProperty.call(cur, seg)) return { ok: false, reason: `"${ref}" does not resolve` };
      cur = (cur as Record<string, Json>)[seg];
    }
  }
  return deref(cur, doc, seen, depth + 1, refuseSiblings);
}

/**
 * A structural key for comparing two schema fragments, and for comparing enum
 * members without losing their JSON type: `1` and `"1"` are different values a
 * vendor may accept, and `String()` would collapse them. Keys are sorted so
 * property order is not mistaken for a change, arrays keep their order,
 * cycles are marked rather than followed, and nothing here builds a plain
 * object, so a published `__proto__` key cannot reach a prototype.
 */
export function stableKey(value: Json): string {
  const seen = new WeakSet<object>();
  const norm = (x: Json): Json => {
    if (x === null || typeof x !== 'object') return typeof x === 'undefined' ? ['undefined'] : x;
    if (seen.has(x as object)) return ['[circular]'];
    seen.add(x as object);
    if (Array.isArray(x)) return ['[]', ...x.map(norm)];
    return ['{}', ...Object.keys(x).sort().map((k) => [k, norm((x as Record<string, Json>)[k])])];
  };
  try {
    return JSON.stringify(norm(value)) ?? 'undefined';
  } catch {
    return '[unserialisable]';
  }
}

export interface FieldInfo {
  /** Required at its own level, per its parent's `required` array. */
  required: boolean;
  /** Enum members as published, JSON types intact. `null` means unconstrained. */
  enumValues: Json[] | null;
  /** `type` as published, or `null` when the vendor does not declare one. */
  type: string | null;
}

/**
 * The refusal a well-formed anyOf/oneOf gets. Its shape is not compared, but
 * the field it sits on is named, so unlike a broken `$ref` its presence is.
 */
export const UNION_REFUSAL = 'an anyOf/oneOf union, which this check does not compare';

export interface Shape {
  /** Dotted path → what is known about it. `''` is never a key; the root is described by the container. */
  fields: Map<string, FieldInfo>;
  /**
   * Paths whose sub-structure the vendor does not enumerate — a free-form
   * object. Nothing beneath them is comparable, and nothing beneath them may
   * be reported as removed. `''` means the whole shape is free-form.
   */
  opaque: Set<string>;
  /** Path → why it could not be read. Forbids comparison at and beneath that path. */
  unknowns: Map<string, string>;
}

export function emptyShape(): Shape {
  return { fields: new Map(), opaque: new Set(), unknowns: new Map() };
}

/** Is `path` at or beneath `root`? `''` is the root of everything. */
export function under(path: string, root: string): boolean {
  if (root === '') return true;
  return path === root || path.startsWith(`${root}.`) || path.startsWith(`${root}[`);
}

function childPath(prefix: string, key: string): string {
  return prefix ? `${prefix}.${key}` : key;
}

interface Merged {
  type: string | null;
  enumValues: Json[] | null;
  properties: Map<string, Json>;
  required: Set<string>;
  items?: Json;
  declaresProperties: boolean;
}

/**
 * Folds one schema — and any `allOf` chain under it — into `target`.
 * Returns false when the fragment is ambiguous or unreadable, having already
 * recorded why at `path`.
 */
function mergeInto(target: Merged, schema: Json, doc: Json, path: string, out: Shape, depth: number): boolean {
  const resolved = deref(schema, doc);
  if (!resolved.ok) {
    out.unknowns.set(path, resolved.reason);
    return false;
  }
  const node = resolved.node;
  if (!node || typeof node !== 'object' || Array.isArray(node)) return true;

  if (Array.isArray(node.anyOf) || Array.isArray(node.oneOf)) {
    out.unknowns.set(path, UNION_REFUSAL);
    return false;
  }

  if (Array.isArray(node.allOf)) {
    if (depth >= MAX_SHAPE_DEPTH) {
      out.unknowns.set(path, `an allOf chain runs deeper than ${MAX_SHAPE_DEPTH} levels`);
      return false;
    }
    for (const part of node.allOf) {
      if (!mergeInto(target, part, doc, path, out, depth + 1)) return false;
    }
  }

  if (typeof node.type === 'string') {
    if (target.type !== null && target.type !== node.type) {
      out.unknowns.set(path, `two allOf branches declare different types (${target.type} and ${node.type})`);
      return false;
    }
    target.type = node.type;
  }

  if (Array.isArray(node.enum)) {
    if (target.enumValues === null) {
      target.enumValues = node.enum.slice();
    } else {
      // Two enums under one allOf accept only what both accept.
      const keep = new Set(node.enum.map(stableKey));
      target.enumValues = target.enumValues.filter((v) => keep.has(stableKey(v)));
    }
  }

  const props = node.properties;
  if (props && typeof props === 'object' && !Array.isArray(props)) {
    target.declaresProperties = true;
    for (const [key, sub] of Object.entries(props as Record<string, Json>)) {
      const existing = target.properties.get(key);
      if (existing !== undefined && stableKey(existing) !== stableKey(sub)) {
        // Intersecting two different definitions of one field is exactly the
        // guess this reader refuses to make.
        out.unknowns.set(childPath(path, key), 'two allOf branches define this field differently');
        continue;
      }
      target.properties.set(key, sub);
    }
  }

  if (Array.isArray(node.required)) {
    for (const r of node.required) if (typeof r === 'string') target.required.add(r);
  }

  if (node.items !== undefined) {
    if (target.items !== undefined && stableKey(target.items) !== stableKey(node.items)) {
      out.unknowns.set(path, 'two allOf branches define array items differently');
      return false;
    }
    target.items = node.items;
  }

  return true;
}

function walk(schema: Json, doc: Json, path: string, requiredHere: boolean, out: Shape, depth: number): void {
  if (depth > MAX_SHAPE_DEPTH) {
    out.unknowns.set(path, `the schema nests deeper than this check follows (${MAX_SHAPE_DEPTH} levels)`);
    return;
  }

  const merged: Merged = {
    type: null,
    enumValues: null,
    properties: new Map(),
    required: new Set(),
    declaresProperties: false,
  };
  const readable = mergeInto(merged, schema, doc, path, out, 0);

  if (path) {
    out.fields.set(path, {
      required: requiredHere,
      enumValues: readable ? merged.enumValues : null,
      type: readable ? merged.type : null,
    });
  }
  if (!readable) return;

  if (merged.items !== undefined) {
    // An element of a required array is itself required: a caller obliged to
    // send `line_items` is obliged to send whatever `line_items[]` demands.
    walk(merged.items, doc, `${path}[]`, requiredHere, out, depth + 1);
    return;
  }

  if (merged.properties.size > 0) {
    for (const [key, sub] of merged.properties) {
      walk(sub, doc, childPath(path, key), merged.required.has(key), out, depth + 1);
    }
    return;
  }

  // Nothing enumerated. `properties: {}` and no `properties` key at all are
  // different statements and must not be conflated: the first says this object
  // has no fields, which makes a field the baseline listed a removal; the
  // second says the vendor never enumerated them, which makes it a blob with
  // nothing to lose. Only the second is opaque.
  if (!merged.declaresProperties && (merged.type === 'object' || merged.type === null)) {
    out.opaque.add(path);
  }
}

/** Flattens one schema into dotted field paths. */
export function readShape(schema: Json, doc: Json): Shape {
  const shape = emptyShape();
  walk(schema, doc, '', false, shape, 0);
  return shape;
}

/** A shape that could not be read at all, reported at its root. */
function unreadableShape(reason: string): Shape {
  const shape = emptyShape();
  shape.unknowns.set('', reason);
  return shape;
}

/** A body or response with no schema: present, and nothing about it is claimable. */
function opaqueShape(): Shape {
  const shape = emptyShape();
  shape.opaque.add('');
  return shape;
}

function readMediaMap(content: Json, doc: Json): Map<string, Shape> {
  const media = new Map<string, Shape>();
  if (!content || typeof content !== 'object' || Array.isArray(content)) return media;
  for (const [contentType, entry] of Object.entries(content as Record<string, Json>)) {
    const resolved = deref(entry, doc);
    if (!resolved.ok) {
      media.set(contentType, unreadableShape(resolved.reason));
      continue;
    }
    const schema = resolved.node?.schema;
    media.set(contentType, schema === undefined ? opaqueShape() : readShape(schema, doc));
  }
  return media;
}

export interface RequestView {
  /** Media type → flattened shape. Every media type the vendor lists, not the first. */
  media: Map<string, Shape>;
  /** Whether the operation declares a request body at all. */
  present: boolean;
  /** `requestBody.required` — going from false to true breaks every existing caller. */
  bodyRequired: boolean;
  /** Set when the request body itself could not be read. */
  unknown?: string;
}

export function requestView(op: Json, doc: Json): RequestView {
  const raw = op?.requestBody;
  if (raw === undefined || raw === null) return { media: new Map(), present: false, bodyRequired: false };

  const resolved = deref(raw, doc);
  if (!resolved.ok) return { media: new Map(), present: true, bodyRequired: false, unknown: resolved.reason };

  const body = resolved.node;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { media: new Map(), present: true, bodyRequired: false, unknown: 'the request body is not an object' };
  }
  return { media: readMediaMap(body.content, doc), present: true, bodyRequired: body.required === true };
}

export interface StatusView {
  /** Media type → flattened shape. */
  media: Map<string, Shape>;
  /**
   * Set when this response could not be read. It is kept per status rather
   * than faked as a missing media type: an unreadable response must not
   * produce the confident claim that a media type was withdrawn.
   */
  unknown?: string;
}

export interface ResponseView {
  /** Status code → what that response offers. All 2xx statuses, not the first. */
  statuses: Map<string, StatusView>;
  /** Set when the responses object itself could not be read. */
  unknown?: string;
}

/**
 * Success responses. All `2xx` codes are compared; `2XX` and then `default`
 * stand in only when the vendor declares no explicit 2xx, because alongside a
 * declared success `default` describes the error case and comparing it against
 * a success shape would manufacture findings.
 */
export function responseView(op: Json, doc: Json): ResponseView {
  const statuses = new Map<string, StatusView>();
  const responses = op?.responses;
  if (!responses || typeof responses !== 'object' || Array.isArray(responses)) {
    return { statuses, unknown: 'the operation declares no responses object' };
  }

  const keys = Object.keys(responses as Record<string, Json>);
  let codes = keys.filter((c) => /^2\d\d$/.test(c));
  if (codes.length === 0) codes = keys.filter((c) => /^2xx$/i.test(c));
  if (codes.length === 0) codes = keys.filter((c) => c === 'default');

  for (const code of codes.sort()) {
    const resolved = deref((responses as Record<string, Json>)[code], doc);
    if (!resolved.ok) {
      statuses.set(code, { media: new Map(), unknown: resolved.reason });
      continue;
    }
    const node = resolved.node;
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      statuses.set(code, { media: new Map(), unknown: 'the response is not an object' });
      continue;
    }
    // A response with no content (a 204, say) is an empty media map, which
    // compares equal to another empty one and reports nothing.
    statuses.set(code, { media: readMediaMap(node.content, doc) });
  }
  return { statuses };
}

export interface ParamRef {
  name: string;
  location: string;
  required: boolean;
  /** The parameter's own schema, for enum and type comparison. */
  schema: Json;
  /** The resolved Parameter Object itself (`deprecated`, `style`, `explode`, …). */
  raw: Json;
}

export interface ParameterView {
  /** `<in>:<name>` → parameter. Operation-level entries override path-level ones. */
  params: Map<string, ParamRef>;
  /** Entries that could not be read, each with its reason. */
  unknowns: string[];
  /**
   * ids (`<in>:<name>`) whose entry came from the path item and was NOT
   * overridden by a resolvable operation-level entry of the same id.
   */
  inheritedIds: Set<string>;
  /**
   * true when the operation's own `parameters` array contained an entry
   * that could not be resolved at all (an external/unresolved `$ref`). Such
   * an entry's name and `in` are unknown, so it could be overriding ANY
   * inherited path-level parameter — the whole inherited set becomes
   * unreadable for this operation, not just the one entry that failed.
   */
  operationParamsUnresolved: boolean;
}

/**
 * Parameters, inheriting the path item's. A vendor that declares
 * `{name: "org", in: "path", required: true}` once on the path item and never
 * repeats it per operation is completely ordinary, and reading only
 * `operation.parameters` misses it.
 */
export function parameters(op: Json, pathItem: Json, doc: Json): ParameterView {
  const params = new Map<string, ParamRef>();
  const unknowns: string[] = [];
  const inheritedIds = new Set<string>();
  let operationParamsUnresolved = false;

  const add = (list: Json, fromOperation: boolean): void => {
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      const resolved = deref(entry, doc);
      if (!resolved.ok) {
        unknowns.push(resolved.reason);
        if (fromOperation) operationParamsUnresolved = true;
        continue;
      }
      const p = resolved.node;
      if (!p || typeof p !== 'object' || Array.isArray(p) || typeof p.name !== 'string') {
        unknowns.push('a parameter entry has no name');
        continue;
      }
      const location = typeof p.in === 'string' ? p.in : 'query';
      const id = `${location}:${p.name}`;
      params.set(id, {
        name: p.name,
        location,
        // A path parameter is required by definition, whether or not it says so.
        required: p.required === true || location === 'path',
        schema: p.schema,
        raw: p,
      });
      if (fromOperation) {
        inheritedIds.delete(id);
      } else {
        inheritedIds.add(id);
      }
    }
  };

  add(pathItem?.parameters, false);
  add(op?.parameters, true);
  return { params, unknowns, inheritedIds, operationParamsUnresolved };
}

/**
 * A probe over a possibly-`$ref`erenced schema. `ok: false` means the ref
 * itself could not be resolved — genuinely unknown, and must never be read
 * as "declares nothing" — distinct from `ok: true, value: null`, which means
 * the schema resolved fine and simply has no type/enum declared.
 */
export type SchemaProbeResult<T> = { ok: true; value: T | null } | { ok: false; reason: string };

/** Enum members of a standalone schema (a parameter's), JSON types intact. */
export function enumOfSchema(schema: Json, doc: Json): SchemaProbeResult<Json[]> {
  const resolved = deref(schema, doc);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  const s = resolved.node;
  if (!s || typeof s !== 'object' || !Array.isArray(s.enum)) return { ok: true, value: null };
  return { ok: true, value: s.enum.slice() };
}

/** Declared `type` of a standalone schema, or null. */
export function typeOfSchema(schema: Json, doc: Json): SchemaProbeResult<string> {
  const resolved = deref(schema, doc);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  const s = resolved.node;
  if (!s || typeof s !== 'object' || typeof s.type !== 'string') return { ok: true, value: null };
  return { ok: true, value: s.type };
}
