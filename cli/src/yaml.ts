/**
 * YAML parsing for spec documents, on top of the `yaml` npm package
 * (eemeli/yaml — ISC, zero runtime dependencies of its own).
 *
 * A hand-written parser used to live here. It was replaced (follow-up
 * review, 2026-09-30) after two rounds of P1s traced to it: real-world specs
 * hit line-based-parsing edge cases (multi-line plain scalars, more-indented
 * folded-scalar continuations, `\uXXXX` escapes in flow collections, trailing
 * commas, `__proto__` keys, anchors/aliases/tags) faster than they could be
 * patched one at a time, and each patch only covered the one shape that had
 * just been found live. `yaml` is a spec-conformant, actively maintained
 * parser; patching a hand-rolled one against every corner of the YAML 1.2
 * grammar was the wrong shape of fix for that.
 *
 * The comparison this feeds is used to write breaking-change counts into
 * emails sent to API owners, so the options below stay deliberately
 * conservative even where they diverge from what a general-purpose YAML tool
 * would default to:
 *
 *   - `uniqueKeys: true` — a duplicate mapping key is a document defect, not
 *     "last one wins."
 *   - `merge: false` — no YAML 1.1 `<<` merge keys; a spec's fields should be
 *     visible in the document, not assembled through a merge the diff would
 *     then have to re-derive.
 *   - `maxAliasCount: 0` on the `toJS()` resolution call (it is a resolution
 *     option, not a parse option), AND an explicit walk that rejects any
 *     anchor or alias outright before resolution is even attempted (the
 *     option alone only stops re-*using* an anchor — a defined-but-
 *     unreferenced anchor would otherwise pass silently). A spec
 *     is compared as the document it says it is: an anchor/alias expands
 *     into content that is not written where the diff is looking, which is
 *     exactly the shape of bug that hid a real change before (an aliased
 *     operation read as a plain string and reported removed).
 *   - Multi-document input (more than one `---`-separated document) throws,
 *     rather than silently comparing only the first.
 *   - YAML 1.2, `core` schema (the library's default) — the one behaviour
 *     this file used to special-case, an unquoted `1.0` staying a string
 *     under `version:`-shaped keys, needs no special-casing: it is what the
 *     core schema already does.
 *
 * Anything the real grammar resolves correctly that the hand-written parser
 * used to reject as "not supported" (an explicit `!!str` tag, a folded
 * multi-line plain scalar) is now parsed per spec instead of refused — only
 * anchors, aliases and more-than-one-document are still hard refusals, for
 * the reasons above.
 */

import { parseAllDocuments, visit, type Document, type ParsedNode } from 'yaml';
import type { Json } from './spec.js';

export class YamlParseError extends Error {}

/**
 * Rejects any anchor definition (`&name`) or alias use (`*name`) anywhere in
 * the document, regardless of whether an alias is ever actually resolved.
 * `maxAliasCount: 0` on its own only stops an alias from being *read*; a
 * `&name` that is never referenced would otherwise parse silently.
 */
function rejectAnchorsAndAliases(doc: Document<ParsedNode, true>): void {
  visit(doc, {
    Alias(_key, node) {
      throw new YamlParseError(`YAML: an alias ("*${node.source}") is not supported`);
    },
    Value(_key, node) {
      const anchor = (node as { anchor?: unknown }).anchor;
      if (typeof anchor === 'string' && anchor.length > 0) {
        throw new YamlParseError(`YAML: an anchor ("&${anchor}") is not supported`);
      }
    },
  });
}

/**
 * Parses the single YAML document in `text`. A leading `---` document marker
 * is skipped, a trailing `...` is allowed, and an empty document is `null`.
 * More than one `---`-separated document is a parse error, never silently
 * narrowed to the first.
 */
export function parseYaml(text: string): Json {
  let docs: Array<Document<ParsedNode, true>>;
  try {
    docs = parseAllDocuments(text, {
      uniqueKeys: true,
      merge: false,
      version: '1.2',
      schema: 'core',
      strict: true,
    }) as Array<Document<ParsedNode, true>>;
  } catch (e) {
    throw new YamlParseError(`YAML: ${(e as Error).message}`);
  }

  if (docs.length === 0) return null;
  if (docs.length > 1) {
    throw new YamlParseError('YAML: multiple documents in one file are not supported');
  }
  const doc = docs[0]!;

  rejectAnchorsAndAliases(doc);

  if (doc.errors.length > 0) {
    throw new YamlParseError(`YAML: ${doc.errors[0]!.message}`);
  }

  if (doc.contents == null) return null;
  let result: Json;
  try {
    result = doc.toJS({ mapAsMap: false, maxAliasCount: 0 }) as Json;
  } catch (e) {
    // An alias whose anchor is not yet defined at the point it is used
    // (a forward reference) throws during resolution rather than at parse
    // time; `isAlias` above already refuses every alias node up front, so
    // this is unreachable in practice and kept only as a safety net.
    throw new YamlParseError(`YAML: ${(e as Error).message}`);
  }
  return result;
}
