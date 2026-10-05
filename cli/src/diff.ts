/**
 * The comparison. Two indexed specs, one list of endpoints the customer
 * declared, out comes a list of findings about those endpoints and nothing else.
 *
 * The filter is the product. A free OpenAPI differ will tell you that a vendor
 * changed 1,400 things; this says which four of them touch the endpoints you
 * call, and stays quiet about the rest.
 *
 * Three invariants are tested, not just intended:
 *   - an endpoint missing from the baseline is a reported finding, never a
 *     clean result, because a typo in a manifest would otherwise read as safety;
 *   - a construct the reader refuses produces `not_compared` at the path it was
 *     met, and nothing beneath that path is compared or claimed either way;
 *   - a spec that could not be read at all produces `unknown` for every
 *     declared endpoint, never a list of removals.
 *
 * `unknown` and `not_compared` are both "not verified" and are separated by
 * one question: did the check run? A spec that would not fetch is `unknown`
 * and fails the build, because it is otherwise indistinguishable from a quiet
 * week. A schema built from `anyOf` is `not_compared`: the check ran, this is
 * a standing limit of the comparison, it will read the same every week, and a
 * permanently red build teaches a reader to ignore the report.
 *
 * Severity is assigned from the caller's side of the wire, which is why the
 * same change is graded differently in a request and a response. A request
 * enum that loses a value breaks the caller who sends it. A response enum that
 * *gains* one breaks the caller whose switch statement has no branch for it.
 */

import { UNRESOLVED_REQUEST_REF, UNRESOLVED_RESPONSE_REF } from './load-spec.js';
import {
  endpointKey,
  enumOfSchema,
  parameters,
  requestView,
  responseView,
  stableKey,
  typeOfSchema,
  UNION_REFUSAL,
  under,
  type Json,
  type Shape,
  type SpecDoc,
} from './spec.js';
import type { EndpointRef, Finding, FindingKind, Severity } from './types.js';

export interface DiffInput {
  vendor: string;
  baseline: SpecDoc;
  current: SpecDoc;
  endpoints: EndpointRef[];
  /**
   * `"METHOD path"` keys (see `match-endpoints.ts`'s `AlignResult`) whose
   * pairing across the two documents is itself uncertain — two source path
   * items proposed the same destination and neither could be confidently
   * matched to it. Reported `unknown`; body and parameters are not compared.
   * Only set by `diff` (which runs `alignPaths`); `check` never sets it.
   */
  ambiguous?: ReadonlySet<string>;
  /**
   * `"METHOD path"` keys whose effective server address differs between the
   * two documents. Reported `server_changed`; body and parameters are not
   * compared. Only set by `diff`; `check` never sets it.
   */
  serverChanged?: ReadonlySet<string>;
  /**
   * `"METHOD path"` -> `"METHOD path"`, in both directions (see
   * `match-endpoints.ts`'s `AlignResult.possiblyMoved`): an operation
   * unmatched on one side paired with an operation unmatched on the other
   * side that would line up under a root-prefix move, had realignment not
   * been skipped for the whole document. Reported once per pair as
   * `possibly_moved`; neither side is compared or counted as an ordinary
   * removal or addition. Only set by `diff`; `check` never sets it.
   */
  possiblyMoved?: ReadonlyMap<string, string>;
}

export interface DiffResult {
  findings: Finding[];
  endpointsChecked: number;
  endpointsSkipped: number;
  additiveChanges: number;
}

/** Which side of the wire a shape sits on. It decides what counts as breaking. */
type Side = 'request' | 'response';

function values(list: Json[]): string[] {
  return list.map((v) => JSON.stringify(v) ?? String(v));
}

export function diffEndpoints(input: DiffInput): DiffResult {
  const { vendor, baseline, current, endpoints, ambiguous, serverChanged, possiblyMoved } = input;
  const findings: Finding[] = [];
  let checked = 0;
  let skipped = 0;
  let additive = 0;
  const possiblyMovedHandled = new Set<string>();

  const emit = (
    kind: FindingKind,
    severity: Severity,
    endpoint: string,
    detail: string,
    at?: string,
    paths?: string[]
  ): void => {
    findings.push({
      kind,
      severity,
      vendor,
      endpoint,
      detail,
      ...(at === undefined ? {} : { at }),
      // Only the grouped-refusal branch sets `paths`, and findings without it
      // carry no key at all — not `undefined`, not an empty array — so the
      // JSON for every other finding stays byte-identical.
      ...(paths === undefined ? {} : { paths }),
    });
  };

  /**
   * Every refused path in a newly-added status/media shape, grouped by
   * reason and reported `not_compared` — the same grouping `compareShapes`
   * uses for a REAL comparison's refusals, applied here to a shape with
   * nothing on the other side to compare it against at all. An added entry
   * is additive by itself, but a refusal anywhere inside it — not just at
   * its root — must still be surfaced, not silently assumed fine just
   * because it is new.
   */
  const emitAddedShapeUnknowns = (shapeB: Shape, code: string, contentType: string, endpoint: string): void => {
    const byReason = new Map<string, string[]>();
    for (const [path, why] of shapeB.unknowns) {
      const paths = byReason.get(why) ?? [];
      paths.push(path);
      byReason.set(why, paths);
    }
    for (const [why, rawPaths] of byReason) {
      const tops = topmost(rawPaths);
      const first = tops[0];
      if (tops.length === 1 && first !== undefined) {
        emit(
          'not_compared',
          'not_compared',
          endpoint,
          `the added ${contentType} response for ${code} was not compared: ${why}`,
          join(`response.${code}`, first)
        );
      } else {
        const examples = tops.slice(0, 3).map((p) => p || '(root)').join(', ');
        emit(
          'not_compared',
          'not_compared',
          endpoint,
          `${tops.length} fields in the added ${contentType} response for ${code} were not compared — ${why} — at ${examples}${
            tops.length > 3 ? ' and elsewhere' : ''
          }`,
          `response.${code}`,
          [...tops]
        );
      }
    }
  };

  // A spec that could not be read is not a spec full of removals.
  const unreadable = baseline.unreadable ?? current.unreadable;
  if (unreadable) {
    const which = baseline.unreadable ? 'baseline' : 'current';
    for (const endpoint of endpoints) {
      skipped += 1;
      emit('unknown', 'unknown', endpointKey(endpoint), `the ${which} specification could not be read: ${unreadable}`);
    }
    return { findings, endpointsChecked: 0, endpointsSkipped: skipped, additiveChanges: 0 };
  }

  /**
   * Compares one flattened shape against another.
   *
   * Three rules keep the output readable without making it less true, and all
   * three came out of running this against Stripe's real specification, where
   * an earlier draft produced 27 findings for one removed object and 201
   * separate unknowns for one heavily-unioned schema:
   *
   *   - **A removal is reported at its root.** If `coupon` is gone, its 26
   *     nested fields went with it; the finding names the parent and counts
   *     the rest.
   *   - **Refusals are grouped by reason.** One line saying 38 fields are
   *     `anyOf` unions is honest and actionable. Thirty-eight lines saying it
   *     separately are neither.
   *   - **A requirement only breaks a caller who was already obliged.** A new
   *     required field inside a brand-new optional object breaks nobody,
   *     because nobody was sending that object. It is counted as additive.
   */
  const compareShapes = (a: Shape, b: Shape, at: string, endpoint: string, side: Side): void => {
    // path → why it was refused, and which side refused it.
    const refusals = new Map<string, { side: string; why: string }>();
    for (const [path, why] of a.unknowns) refusals.set(path, { side: 'baseline', why });
    for (const [path, why] of b.unknowns) {
      if (!refusals.has(path)) refusals.set(path, { side: 'current spec', why });
    }

    const byReason = new Map<string, { side: string; why: string; paths: string[] }>();
    for (const [path, refusal] of refusals) {
      const id = `${refusal.side} ${refusal.why}`;
      const group = byReason.get(id) ?? { side: refusal.side, why: refusal.why, paths: [] };
      group.paths.push(path);
      byReason.set(id, group);
    }
    for (const group of byReason.values()) {
      const tops = topmost(group.paths);
      const first = tops[0];
      if (tops.length === 1 && first !== undefined) {
        emit('not_compared', 'not_compared', endpoint, `not compared in the ${group.side}: ${group.why}`, join(at, first));
      } else {
        const examples = tops.slice(0, 3).map((p) => p || '(root)').join(', ');
        emit(
          'not_compared',
          'not_compared',
          endpoint,
          `${tops.length} fields were not compared in the ${group.side} — ${group.why} — at ${examples}${
            tops.length > 3 ? ' and elsewhere' : ''
          }`,
          at,
          // The detail keeps naming three examples; `paths` is the full
          // sorted list (`tops` is already sorted), so the report can be held
          // to every refused field rather than the first three.
          [...tops]
        );
      }
    }

    const isRefused = (path: string): boolean => {
      for (const root of refusals.keys()) if (under(path, root)) return true;
      return false;
    };
    // A refused union still names its field, so its presence is comparable
    // even though its shape is not: `customer` vanishing from a Checkout
    // Session is a removal whether or not `customer` is an anyOf. Any other
    // refusal (a broken $ref, a depth limit) still hides its own path, and a
    // path the current spec refused is never called removed.
    const hiddenFromRemoval = (path: string): boolean => {
      for (const [root, refusal] of refusals) {
        if (!under(path, root)) continue;
        // `list[]` is not a named field but the element slot of one: an array
        // whose items stopped being described has not lost a field.
        if (root !== path || refusal.why !== UNION_REFUSAL || path.endsWith('[]')) return true;
      }
      return b.unknowns.has(path);
    };
    const opaqueIn = (shape: Shape, path: string): string | null => {
      for (const root of shape.opaque) if (root !== path && under(path, root)) return root;
      return null;
    };

    // ---- Fields the baseline listed and the current spec does not ----------
    const removed: string[] = [];
    const stoppedEnumerating = new Set<string>();
    for (const path of a.fields.keys()) {
      if (hiddenFromRemoval(path)) continue;
      if (b.fields.has(path)) continue;
      const blob = opaqueIn(b, path);
      if (blob !== null) {
        stoppedEnumerating.add(blob);
        continue;
      }
      removed.push(path);
    }
    for (const blob of stoppedEnumerating) {
      emit(
        'not_compared',
        'not_compared',
        endpoint,
        'the current specification no longer enumerates the fields of this object, so the fields the baseline listed could not be compared',
        join(at, blob)
      );
    }
    for (const top of topmost(removed)) {
      const nested = removed.filter((p) => p !== top && under(p, top)).length;
      const withNested = nested === 0 ? '' : ` (and its ${nested} nested field${nested === 1 ? '' : 's'})`;
      emit(
        side === 'request' ? 'request_field_removed' : 'response_field_removed',
        'breaking',
        endpoint,
        side === 'request'
          ? `request field "${top}" no longer appears in the schema${withNested}`
          : `response field "${top}" no longer appears in the schema${withNested}`,
        join(at, top)
      );
    }

    // ---- Everything the current spec says about a field it still has -------
    const nowRequired: string[] = [];
    const arrived = new Set<string>();

    for (const [path, info] of b.fields) {
      if (isRefused(path)) continue;
      const was = a.fields.get(path);

      if (side === 'request' && info.required && was?.required !== true) {
        if (requirementBinds(a, b, path)) {
          nowRequired.push(path);
          if (was === undefined) arrived.add(path);
        } else {
          additive += 1;
        }
        continue;
      }
      if (was === undefined) {
        additive += 1;
        continue;
      }

      if (was.type !== null && info.type !== null && was.type !== info.type) {
        emit(
          'field_type_changed',
          'breaking',
          endpoint,
          `"${path}" changed type from ${was.type} to ${info.type}`,
          join(at, path)
        );
      }

      const wasEnum = was.enumValues;
      const isEnum = info.enumValues;
      if (wasEnum === null && isEnum !== null) {
        if (side === 'request') {
          emit(
            'enum_now_restricted',
            'breaking',
            endpoint,
            `"${path}" was unrestricted and now accepts only ${values(isEnum).join(', ')}`,
            join(at, path)
          );
        } else {
          additive += 1;
        }
        continue;
      }
      if (wasEnum === null || isEnum === null) {
        // Either unchanged-unrestricted, or a restriction was lifted.
        if (wasEnum !== null) additive += 1;
        continue;
      }

      const nowKeys = new Set(isEnum.map(stableKey));
      const wasKeys = new Set(wasEnum.map(stableKey));
      const gone = wasEnum.filter((v) => !nowKeys.has(stableKey(v)));
      const added = isEnum.filter((v) => !wasKeys.has(stableKey(v)));

      if (side === 'request') {
        if (gone.length > 0) {
          // The replacement set is part of the finding because it is the whole
          // fix. Stripe renaming every `ui_mode` value between two pinned
          // versions is the canonical case: knowing "hosted" is gone is half
          // the answer, and "it is now hosted_page" is the other half.
          const now = isEnum.length > 0 ? ` (it now accepts ${values(isEnum).join(', ')})` : '';
          emit(
            'enum_value_removed',
            'breaking',
            endpoint,
            `"${path}" no longer accepts ${values(gone).join(', ')}${now}`,
            join(at, path)
          );
        }
        additive += added.length;
      } else {
        if (added.length > 0) {
          emit(
            'enum_value_added',
            'advisory',
            endpoint,
            `"${path}" may now return ${values(added).join(', ')}, which the baseline did not list`,
            join(at, path)
          );
        }
        additive += gone.length;
      }
    }

    for (const top of topmost(nowRequired)) {
      const nested = nowRequired.filter((p) => p !== top && under(p, top)).length;
      const withNested = nested === 0 ? '' : ` (and ${nested} required field${nested === 1 ? '' : 's'} inside it)`;
      emit(
        'request_field_now_required',
        'breaking',
        endpoint,
        arrived.has(top)
          ? `"${top}" is a new required request field${withNested}`
          : `"${top}" is now a required request field${withNested}`,
        join(at, top)
      );
    }
  };

  for (const endpoint of endpoints) {
    const key = endpointKey(endpoint);

    // Handled before either "missing" branch below: an operation unmatched
    // on this side that would pair with an unmatched operation on the OTHER
    // side under a root-prefix move is ONE ambiguous pairing, not a removal
    // on one side plus an addition on the other. Only one finding is emitted
    // per pair — `possiblyMovedHandled` marks both keys the first time the
    // pair is seen, so the partner key is silently skipped when it is
    // reached later in this same loop.
    if (possiblyMovedHandled.has(key)) continue;
    const possiblyMovedPartner = possiblyMoved?.get(key);
    if (possiblyMovedPartner !== undefined) {
      possiblyMovedHandled.add(key);
      possiblyMovedHandled.add(possiblyMovedPartner);
      checked += 1;
      emit(
        'possibly_moved',
        'unknown',
        key,
        `this operation is unmatched here, and "${possiblyMovedPartner}" is unmatched in the other specification — the two would pair under a root prefix move, but realignment was skipped for the whole document because another part of it has its own server override, so the pairing could not be confirmed and neither side's body or parameters were compared`
      );
      continue;
    }

    const before = baseline.operations.get(key);

    if (!before) {
      skipped += 1;
      emit(
        'endpoint_not_in_baseline',
        'unknown',
        key,
        current.operations.has(key)
          ? "not present in the baseline spec but present in the current one, so nothing could be compared — the baseline may predate the endpoint, or the path template may not match the vendor's"
          : "not present in either spec — check the path template against the vendor's document"
      );
      continue;
    }

    const after = current.operations.get(key);
    if (!after) {
      checked += 1;
      emit('operation_removed', 'breaking', key, 'present in the baseline, absent from the current spec');
      continue;
    }

    checked += 1;

    if (ambiguous?.has(key)) {
      // Two source path items proposed the same destination and neither
      // could be confidently paired — comparing bodies or parameters here
      // would be comparing operations that might not even be the same one.
      emit(
        'unknown',
        'unknown',
        key,
        'this operation could not be confidently paired between the two specifications: more than one path proposed the same match, so none of them were paired'
      );
      continue;
    }

    if (serverChanged?.has(key)) {
      // The operation itself may be unchanged, but its effective server
      // address is not — comparing its body or parameters against the
      // wrong address would be a guess, not a comparison.
      emit(
        'server_changed',
        'unknown',
        key,
        'the effective server address for this operation differs between the two specifications'
      );
      continue;
    }

    if (!before.deprecated && after.deprecated) {
      emit('operation_deprecated', 'deprecation', key, 'marked deprecated since the baseline');
    }

    // ---- Request body -----------------------------------------------------
    const reqA = requestView(before.raw, baseline.raw);
    const reqB = requestView(after.raw, current.raw);
    // A Swagger 2.0 document whose shared `#/parameters/Name` body parameter
    // could not be resolved at conversion time (load-spec.ts) is marked the
    // same way an unresolved OpenAPI 3 $ref is: not silently read as "no
    // request body".
    const reqARefNote = before.raw?.[UNRESOLVED_REQUEST_REF] as string | undefined;
    const reqBRefNote = after.raw?.[UNRESOLVED_REQUEST_REF] as string | undefined;

    if (reqA.unknown !== undefined || reqB.unknown !== undefined || reqARefNote !== undefined || reqBRefNote !== undefined) {
      emit(
        'not_compared',
        'not_compared',
        key,
        `request body not compared: ${reqA.unknown ?? reqB.unknown ?? reqARefNote ?? reqBRefNote}`,
        'requestBody'
      );
    } else if (reqA.present && !reqB.present) {
      emit(
        'request_body_removed',
        'breaking',
        key,
        'the baseline declared a request body and the current spec declares none',
        'requestBody'
      );
    } else if (reqB.present) {
      if (!reqA.bodyRequired && reqB.bodyRequired && reqA.present) {
        emit(
          'request_body_now_required',
          'breaking',
          key,
          'the request body was optional and is now required',
          'requestBody'
        );
      }
      for (const [contentType, shapeA] of reqA.media) {
        const shapeB = reqB.media.get(contentType);
        if (shapeB === undefined) {
          emit('media_type_removed', 'breaking', key, `the request no longer accepts ${contentType}`, 'requestBody');
          continue;
        }
        compareShapes(shapeA, shapeB, mediaAt('requestBody', contentType, reqA.media.size), key, 'request');
      }
      for (const contentType of reqB.media.keys()) {
        if (!reqA.media.has(contentType)) additive += 1;
      }
    }

    // ---- Parameters -------------------------------------------------------
    const paramsA = parameters(before.raw, before.pathItem, baseline.raw);
    const paramsB = parameters(after.raw, after.pathItem, current.raw);
    for (const why of new Set([...paramsA.unknowns, ...paramsB.unknowns])) {
      emit('not_compared', 'not_compared', key, `a parameter was not compared: ${why}`, 'parameters');
    }
    // A baseline parameter entry that could not even be read as a parameter
    // object at all (an unresolved/external $ref) means the baseline's true
    // parameter set for this operation is not fully known — a parameter that
    // looks "new" here might in fact be that very entry. `parameter_now_
    // required` (and "new and required") is a claim about the baseline NOT
    // having declared something, which cannot be made honestly for the whole
    // operation when part of the baseline could not be read at all. The
    // `not_compared` finding above still names the unreadable entry itself;
    // this only withholds a breaking claim about entries the reader DID read.
    // An operation-level parameter entry that failed to resolve at all (an
    // external/unresolved $ref) has an unknown name and `in` — it could be
    // overriding ANY inherited path-level parameter, not just one sharing
    // its name. Every inherited (path-level-only) parameter's comparison is
    // therefore withheld for the whole operation on that side, reported as
    // one grouped not_compared rather than a per-parameter breakdown. This
    // is distinct from the per-parameter `effectivelyUnreadable` check
    // below, which only catches a shadow of the SAME name.
    const inheritedSuppressedSides: string[] = [];
    if (paramsA.operationParamsUnresolved && paramsA.inheritedIds.size > 0) inheritedSuppressedSides.push('baseline');
    if (paramsB.operationParamsUnresolved && paramsB.inheritedIds.size > 0) inheritedSuppressedSides.push('current');
    if (inheritedSuppressedSides.length > 0) {
      emit(
        'not_compared',
        'not_compared',
        key,
        `inherited path-level parameters were not compared: the operation's own parameters could not be fully resolved in the ${inheritedSuppressedSides.join(' and ')} specification, and the unresolved entry could be overriding any of them`,
        'parameters'
      );
    }

    const baselineParamsUnreadable = paramsA.unknowns.length > 0;
    for (const [id, p] of paramsB.params) {
      const was = paramsA.params.get(id);
      const at = `parameters.${p.location}.${p.name}`;

      const suppressedByUnresolvedOverride =
        (paramsB.operationParamsUnresolved && paramsB.inheritedIds.has(id)) ||
        (paramsA.operationParamsUnresolved && paramsA.inheritedIds.has(id));
      if (suppressedByUnresolvedOverride) continue;

      if (was === undefined) {
        if (!baselineParamsUnreadable && p.required) {
          emit('parameter_now_required', 'breaking', key, `the ${p.location} parameter "${p.name}" is new and required`, at);
        }
        if (!p.required) additive += 1;
        continue;
      }

      const wasTypeR = typeOfSchema(was.schema, baseline.raw);
      const isTypeR = typeOfSchema(p.schema, current.raw);
      const wasEnumR = enumOfSchema(was.schema, baseline.raw);
      const isEnumR = enumOfSchema(p.schema, current.raw);
      // A parameter whose EFFECTIVE entry is unreadable on either side — for
      // example an operation-level override whose own schema contains an
      // unresolved $ref, shadowing an otherwise-fine path-level parameter of
      // the same name — has nothing this check can honestly claim about it:
      // not its required-ness, not its enum, not its type. This is scoped to
      // just THIS parameter, and to either side, unlike `baselineParamsUnreadable`
      // above (round 4's #5 fix), which withholds only the required-ness
      // claim, and only operation-wide, when the baseline's parameter set
      // could not be read AT ALL (its own entry failed to resolve, so it is
      // not even in `paramsA.params` for this to look up).
      const effectivelyUnreadable = !wasTypeR.ok || !isTypeR.ok || !wasEnumR.ok || !isEnumR.ok;

      if (!baselineParamsUnreadable && !effectivelyUnreadable && p.required && !was.required) {
        emit('parameter_now_required', 'breaking', key, `the ${p.location} parameter "${p.name}" is now required`, at);
      }

      if (!wasTypeR.ok || !isTypeR.ok) {
        // An unresolved $ref on either side means this side genuinely cannot
        // be read — never silently treated as "declares no type," which
        // would either hide a real type change (new side unreadable) or
        // invent one against an old side that was never actually seen.
        const reason = !wasTypeR.ok ? wasTypeR.reason : !isTypeR.ok ? isTypeR.reason : '';
        emit('not_compared', 'not_compared', key, `the ${p.location} parameter "${p.name}"'s type was not compared: ${reason}`, at);
      } else if (wasTypeR.value !== null && isTypeR.value !== null && wasTypeR.value !== isTypeR.value) {
        emit(
          'field_type_changed',
          'breaking',
          key,
          `the ${p.location} parameter "${p.name}" changed type from ${wasTypeR.value} to ${isTypeR.value}`,
          at
        );
      }

      if (!wasEnumR.ok || !isEnumR.ok) {
        const reason = !wasEnumR.ok ? wasEnumR.reason : !isEnumR.ok ? isEnumR.reason : '';
        emit('not_compared', 'not_compared', key, `the ${p.location} parameter "${p.name}"'s enum was not compared: ${reason}`, at);
      } else {
        const wasEnum = wasEnumR.value;
        const isEnum = isEnumR.value;
        if (wasEnum === null && isEnum !== null) {
          emit(
            'enum_now_restricted',
            'breaking',
            key,
            `the ${p.location} parameter "${p.name}" was unrestricted and now accepts only ${values(isEnum).join(', ')}`,
            at
          );
        } else if (wasEnum !== null && isEnum !== null) {
          const nowKeys = new Set(isEnum.map(stableKey));
          const gone = wasEnum.filter((v) => !nowKeys.has(stableKey(v)));
          if (gone.length > 0) {
            const now = isEnum.length > 0 ? ` (it now accepts ${values(isEnum).join(', ')})` : '';
            emit(
              'enum_value_removed',
              'breaking',
              key,
              `the ${p.location} parameter "${p.name}" no longer accepts ${values(gone).join(', ')}${now}`,
              at
            );
          }
        }
      }
    }

    // ---- Success responses ------------------------------------------------
    const resA = responseView(before.raw, baseline.raw);
    let resB = responseView(after.raw, current.raw);
    // `responseView` lets `2XX`/`default` stand in for success only when no
    // explicit 2xx exists. A document that moves from "default: successful
    // operation" to "200: successful operation" plus "default: error" (the
    // swagger-petstore history does exactly this) still declares `default`,
    // but no longer as its success response — so the success sets are keyed
    // by different codes and a plain by-code comparison would report the
    // `default` response as withdrawn, which is false, and never compare the
    // success shapes at all. When one side's success is a lone fallback code
    // the other side lacks, it is paired with the other side's single success
    // status; with several there is no honest pairing, and it is said so once.
    const loneFallback = (v: typeof resA): string | undefined => {
      const codes = [...v.statuses.keys()];
      return codes.length === 1 && !/^2\d\d$/.test(codes[0]!) ? codes[0] : undefined;
    };
    let successPairingRefused: string | undefined;
    /** Code a remapped current-side status is keyed under -> its code in the current document itself. */
    const currentCodeOf = new Map<string, string>();
    if (resA.unknown === undefined && resB.unknown === undefined) {
      const fbA = loneFallback(resA);
      const fbB = loneFallback(resB);
      const lacking = (code: string | undefined, other: typeof resA): code is string =>
        code !== undefined && !other.statuses.has(code) && other.statuses.size > 0;
      if (lacking(fbA, resB) || lacking(fbB, resA)) {
        const [fallbackCode, other] = lacking(fbA, resB) ? [fbA!, resB] : [fbB!, resA];
        if (other.statuses.size === 1) {
          const [otherCode] = [...other.statuses.keys()];
          const statusOther = other.statuses.get(otherCode!)!;
          if (other === resB) {
            resB = { ...resB, statuses: new Map([[fallbackCode, statusOther]]) };
            currentCodeOf.set(fallbackCode, otherCode!);
          } else {
            resB = { ...resB, statuses: new Map([[otherCode!, resB.statuses.get(fallbackCode)!]]) };
            currentCodeOf.set(otherCode!, fallbackCode);
          }
        } else {
          successPairingRefused = `one specification describes success only as "${fallbackCode}" and the other as ${[
            ...other.statuses.keys(),
          ].join(', ')}, so which response corresponds to which could not be decided`;
        }
      }
    }
    // Same Swagger 2.0 conversion-time note as the request body, kept per
    // status code: a shared `#/responses/Name` that failed to resolve.
    const swagger2RefNote = (raw: Json, code: string): string | undefined => {
      const responses = raw?.responses;
      const entry = responses && typeof responses === 'object' ? responses[code] : undefined;
      return entry && typeof entry === 'object' ? (entry[UNRESOLVED_RESPONSE_REF] as string | undefined) : undefined;
    };
    if (resA.unknown !== undefined || resB.unknown !== undefined || successPairingRefused !== undefined) {
      emit(
        'not_compared',
        'not_compared',
        key,
        `success response not compared: ${resA.unknown ?? resB.unknown ?? successPairingRefused}`,
        'response'
      );
    } else {
      for (const [code, statusA] of resA.statuses) {
        const statusB = resB.statuses.get(code);
        if (statusB === undefined) {
          emit(
            'response_status_removed',
            'breaking',
            key,
            `the baseline declared a ${code} response and the current spec does not`,
            `response.${code}`
          );
          continue;
        }
        const refNoteA = swagger2RefNote(before.raw, code);
        const refNoteB = swagger2RefNote(after.raw, currentCodeOf.get(code) ?? code);
        if (statusA.unknown !== undefined || statusB.unknown !== undefined || refNoteA !== undefined || refNoteB !== undefined) {
          // An unreadable response is unknown at that status. Comparing its
          // empty media map against the other side's would otherwise announce
          // that every media type had been withdrawn.
          emit(
            'not_compared',
            'not_compared',
            key,
            `the ${code} response was not compared: ${statusA.unknown ?? statusB.unknown ?? refNoteA ?? refNoteB}`,
            `response.${code}`
          );
          continue;
        }
        for (const [contentType, shapeA] of statusA.media) {
          const shapeB = statusB.media.get(contentType);
          if (shapeB === undefined) {
            emit(
              'media_type_removed',
              'breaking',
              key,
              `the ${code} response no longer returns ${contentType}`,
              `response.${code}`
            );
            continue;
          }
          compareShapes(shapeA, shapeB, mediaAt(`response.${code}`, contentType, statusA.media.size), key, 'response');
        }
        for (const [contentType, shapeB] of statusB.media) {
          if (statusA.media.has(contentType)) continue;
          // An added media type is additive by itself — but if it could not
          // actually be read (an unresolved $ref, or a refusal anywhere
          // inside it — not just at its root — same as any other shape),
          // that must be surfaced as `not_compared`, not silently assumed
          // fine just because it is new.
          additive += 1;
          emitAddedShapeUnknowns(shapeB, code, contentType, key);
        }
      }
      for (const [code, statusB] of resB.statuses) {
        if (resA.statuses.has(code)) continue;
        additive += 1;
        const addedRefNote = swagger2RefNote(after.raw, code);
        if (statusB.unknown !== undefined || addedRefNote !== undefined) {
          emit(
            'not_compared',
            'not_compared',
            key,
            `the added ${code} response was not compared: ${statusB.unknown ?? addedRefNote}`,
            `response.${code}`
          );
          continue;
        }
        for (const [contentType, shapeB] of statusB.media) {
          emitAddedShapeUnknowns(shapeB, code, contentType, key);
        }
      }
    }
  }

  return { findings, endpointsChecked: checked, endpointsSkipped: skipped, additiveChanges: additive };
}

export interface RemovedRequestField {
  endpoint: string;
  field: string;
  media: string;
}

/**
 * The request-body half of `request_field_removed`, standalone: every field
 * the baseline declared that the current specification no longer does, for
 * an operation present in both specs and a media type both declare on it.
 *
 * `diffEndpoints` emits this as a pass/fail finding; the marketing site's
 * snapshot (`scripts/snapshot.ts`) needs the removals themselves to list on
 * `/changes/<vendor>`, so this pulls the same rule out rather than
 * reimplementing it: a path under an unresolved union (or anything else the
 * reader could not read) is skipped rather than guessed at, a parent whose
 * object stopped being enumerated at all is not claimed as a removal either,
 * and a removed parent is reported once, not once per nested field.
 */
export function removedRequestFields(baseline: SpecDoc, current: SpecDoc): RemovedRequestField[] {
  const out: RemovedRequestField[] = [];

  for (const [key, opB] of current.operations) {
    const opA = baseline.operations.get(key);
    if (!opA) continue;

    const reqA = requestView(opA.raw, baseline.raw);
    const reqB = requestView(opB.raw, current.raw);
    // An unreadable body, or a body withdrawn/never declared on either side,
    // is a different finding (`not_compared` / `request_body_removed`); it
    // has no fields this function can honestly call "removed".
    if (reqA.unknown !== undefined || reqB.unknown !== undefined) continue;
    if (!reqA.present || !reqB.present) continue;

    for (const [media, shapeA] of reqA.media) {
      const shapeB = reqB.media.get(media);
      // The whole media type is gone — `media_type_removed`, not a field
      // removal. Claiming every one of its fields individually would count
      // the same change under the wrong finding.
      if (shapeB === undefined) continue;

      // Same rule as compareShapes: a refused field's own presence is compared.
      const hiddenFromRemoval = (path: string): boolean => {
        for (const [root, why] of shapeA.unknowns) {
          if (under(path, root) && (root !== path || why !== UNION_REFUSAL || path.endsWith('[]'))) return true;
        }
        for (const root of shapeB.unknowns.keys()) if (under(path, root)) return true;
        return false;
      };
      const stoppedEnumerating = (path: string): boolean => {
        for (const root of shapeB.opaque) if (root !== path && under(path, root)) return true;
        return false;
      };

      const removed: string[] = [];
      for (const path of shapeA.fields.keys()) {
        if (hiddenFromRemoval(path)) continue;
        if (shapeB.fields.has(path)) continue;
        if (stoppedEnumerating(path)) continue;
        removed.push(path);
      }

      for (const top of topmost(removed)) out.push({ endpoint: key, field: top, media });
    }
  }

  out.sort(
    (x, y) => x.endpoint.localeCompare(y.endpoint) || x.media.localeCompare(y.media) || x.field.localeCompare(y.field)
  );
  return out;
}

export interface NewlyRequiredField {
  endpoint: string;
  field: string;
}

/**
 * Fields an existing caller must now send and did not have to send at the
 * baseline — whether they flipped to required or arrived already required.
 * Standalone next to `removedRequestFields` for the same reason: it is the
 * snapshot's `/changes` number, and re-deriving it per page would be a second
 * copy of a rule that has already been wrong twice (see the two exclusions
 * below, both found in the field rather than by review).
 *
 * Two exclusion rules, both about the same principle — only a change that
 * breaks a caller who already exists may be listed:
 *
 *   - A required field whose parent the baseline never had is skipped: an
 *     existing caller never sends the new parent, so nothing about its
 *     interior touches them. If the parent is itself required, the parent is
 *     the thing listed, and this rule is what keeps both from appearing.
 *   - Of `ids` and `ids[]` (the array element slot, required whenever the
 *     array is) only one is listed: an ancestor already in the list covers
 *     the entry beneath it.
 *
 * The request body must be JSON on both sides and readable on both sides, the
 * same preconditions `removedRequestFields` applies; anything else is a
 * different finding or silence, never a guess.
 */
export function newlyRequiredFields(a: SpecDoc, b: SpecDoc): NewlyRequiredField[] {
  const out: NewlyRequiredField[] = [];

  for (const [key, opB] of b.operations) {
    const opA = a.operations.get(key);
    if (!opA) continue;
    const jsonA = requestView(opA.raw, a.raw).media.get('application/json');
    const jsonB = requestView(opB.raw, b.raw).media.get('application/json');
    if (!jsonA || !jsonB) continue;
    if (jsonA.unknowns.size > 0 || jsonB.unknowns.size > 0) continue;
    for (const [field, info] of jsonB.fields) {
      if (!info.required) continue;
      const was = jsonA.fields.get(field);
      if (was?.required) continue;
      // A brand-new parent changes nothing for a caller who never sends it.
      // `ancestorsOf` includes the array stem, so a required `ids[].id` is
      // skipped whenever the baseline had no `ids` — which is correct: the
      // caller was never obliged to send an `ids` array, so nothing inside
      // it can break them.
      if (ancestorsOf(field).some((ancestor) => !jsonA.fields.has(ancestor))) continue;
      out.push({ endpoint: key, field });
    }
  }

  // One obligation, one line. `ids` newly required makes `ids[]` newly
  // required by construction (an element of a required array is itself
  // required), and listing both would count one change twice. Only the
  // element-slot alias is folded: `settings.mode` under a newly required
  // `settings` that already existed is its own obligation, because a caller
  // who sent `{"settings":{}}` must now add `mode` as well.
  const listed = new Set(out.map((f) => `${f.endpoint}\u0000${f.field}`));
  const kept = out.filter((f) => {
    const stem = f.field.replace(/(\[\])+$/, '');
    return stem === f.field || !listed.has(`${f.endpoint}\u0000${stem}`);
  });
  kept.sort((x, y) => x.endpoint.localeCompare(y.endpoint) || x.field.localeCompare(y.field));
  return kept;
}

/**
 * Every proper ancestor of a dotted path, outermost first:
 * `line_items[].price.id` → `line_items`, `line_items[]`, `line_items[].price`.
 * The array stem is included, so the ancestors of `ids[].id` name `ids` itself —
 * which is what lets "the array element slot is covered by the array" be checked
 * with the same walk as any other ancestor.
 */
export function ancestorsOf(path: string): string[] {
  const out: string[] = [];
  let prefix = '';
  for (const segment of path.split('.')) {
    const base = prefix ? `${prefix}.${segment}` : segment;
    const arrays = /^(.*?)((?:\[\])+)$/.exec(base);
    const stem = arrays?.[1];
    const brackets = arrays?.[2];
    if (stem !== undefined && brackets !== undefined) {
      out.push(stem);
      let accumulated = stem;
      for (let i = 0; i < brackets.length / 2; i += 1) {
        accumulated += '[]';
        out.push(accumulated);
      }
    } else {
      out.push(base);
    }
    prefix = base;
  }
  out.pop();
  return out;
}

/**
 * Does "you must now send this" actually break an existing caller?
 *
 * Only if they were already obliged to send everything above it. Stripe adding
 * a required `type` inside a brand-new optional `branding_settings` object
 * breaks nobody — no existing caller sends `branding_settings` at all — and
 * reporting it as breaking is the fastest way to teach a reader to ignore the
 * whole report.
 */
function requirementBinds(a: Shape, b: Shape, path: string): boolean {
  for (const ancestor of ancestorsOf(path)) {
    if (!a.fields.has(ancestor)) return false;
    if (b.fields.get(ancestor)?.required !== true) return false;
  }
  return true;
}

/** The paths in a set that have no other member of the set above them. */
function topmost(paths: string[]): string[] {
  const unique = [...new Set(paths)];
  return unique.filter((p) => !unique.some((q) => q !== p && under(p, q))).sort();
}

/** `requestBody` + `data.id` → `requestBody.data.id`; an empty path stays the container. */
function join(at: string, path: string): string {
  return path ? `${at}.${path}` : at;
}

/**
 * Names the media type only when the operation offers more than one. Stripe
 * accepts form encoding and nothing else, so annotating every path with
 * `(application/x-www-form-urlencoded)` would add a column of noise that
 * distinguishes nothing.
 */
function mediaAt(at: string, contentType: string, alternatives: number): string {
  if (alternatives < 2) return at;
  return contentType === 'application/json' ? at : `${at}(${contentType})`;
}
