/**
 * Getting a spec document — any of the four combinations `apibreak diff`
 * accepts: a local file or an http(s) URL, written as JSON or YAML, describing
 * an OpenAPI 3.x or a Swagger 2.0 API.
 *
 * Fetching reuses `getBody` from fetch.ts rather than a second HTTP client, so
 * `diff` gets the same stall/total deadlines and abort behaviour `check`
 * already relies on, not a copy that can drift.
 */

import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { getBody, httpOk, type FetchDeps } from './fetch.js';
import { deref, indexSpec, type SpecDoc } from './spec.js';
import { parseYaml, YamlParseError } from './yaml.js';

const execFileAsync = promisify(execFile);

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export const USER_AGENT = 'apibreak-diff (+https://apibreak.dev)';

/** 20 s total, per the CLI's contract — a spec is fetched once, not streamed. */
export const DIFF_DEADLINES = { stallMs: 20_000, totalMs: 20_000 };

export type TextResult = { ok: true; text: string } | { ok: false; error: string };
export type DocResult = { ok: true; doc: SpecDoc; raw: Json } | { ok: false; error: string };

export function isUrl(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

async function fetchText(url: string, fetchImpl: typeof fetch): Promise<TextResult> {
  const deps: FetchDeps = { fetch: fetchImpl, now: () => new Date(), deadlines: DIFF_DEADLINES };
  const res = await getBody(
    url,
    { headers: { 'user-agent': USER_AGENT, accept: 'application/json, application/yaml, text/yaml, */*' } },
    deps
  );
  if (!res.ok) return { ok: false, error: res.error };
  if (!httpOk(res.status)) return { ok: false, error: `could not fetch ${url} (HTTP ${res.status})` };
  return { ok: true, text: res.text };
}

async function readLocalFile(path: string): Promise<TextResult> {
  try {
    return { ok: true, text: await readFile(path, 'utf8') };
  } catch (e) {
    return { ok: false, error: `cannot read ${path}: ${(e as Error).message}` };
  }
}

/** A local file or an http(s) URL, dispatched on `source`'s own shape. */
export async function readSpecText(source: string, fetchImpl: typeof fetch): Promise<TextResult> {
  return isUrl(source) ? fetchText(source, fetchImpl) : readLocalFile(source);
}

/**
 * `git show <ref>:<path>` — the file as it existed at another revision,
 * without checking it out. Used by `--base-ref` so a PR can diff its own
 * spec against the branch it targets.
 *
 * `git show <ref>:<path>` always resolves `<path>` relative to the
 * repository root, never to the process's cwd — unlike every other read in
 * this CLI, which reads `workingTreePath` relative to `cwd`. Running the
 * command from a subdirectory with a bare relative path (e.g. `openapi.yaml`
 * meant as `<subdir>/openapi.yaml`) used to compare the wrong two files: the
 * repo-root copy at `<ref>` against the subdirectory's copy in the working
 * tree. `workingTreePath` (the same absolute path `readSpecText` reads) is
 * resolved against the repository root itself via `git rev-parse
 * --show-toplevel`, through `realpath` on both sides so a symlinked tmp
 * directory (macOS) does not falsely read as outside the repo. A path that
 * does not resolve under the repository root is refused outright, and `--`
 * ends option parsing so a ref or path starting with `-` cannot be read as a
 * git flag.
 */
export async function readSpecTextAtGitRef(ref: string, workingTreePath: string, cwd: string): Promise<TextResult> {
  let toplevel: string;
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd });
    toplevel = stdout.trim();
  } catch (e) {
    const message = (e as { stderr?: string; message?: string }).stderr?.trim() || (e as Error).message;
    return { ok: false, error: `git rev-parse --show-toplevel failed: ${message}` };
  }

  const lexicalAbs = isAbsolute(workingTreePath) ? workingTreePath : resolve(cwd, workingTreePath);
  const [realAbs, realToplevel] = await Promise.all([
    realpath(lexicalAbs).catch(() => lexicalAbs),
    realpath(toplevel).catch(() => toplevel),
  ]);

  const rel = relative(realToplevel, realAbs);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return { ok: false, error: `${workingTreePath} is outside the git repository at ${realToplevel}` };
  }
  const repoPath = rel.split(sep).join('/');
  // `git show <rev>:<path>` is a single object-spec argument, not a
  // pathspec — a `--` ahead of it makes git read it as a literal working-tree
  // pathspec instead (silently returning nothing) rather than ending option
  // parsing for it. A `<rev>` or repo-relative path starting with `-` is
  // refused outright instead, so a hostile `--base-ref` value can never be
  // read as a git flag.
  if (ref.startsWith('-') || repoPath.startsWith('-')) {
    return { ok: false, error: `refusing to run git show on "${ref}:${repoPath}": looks like an option, not a revision/path` };
  }

  try {
    const { stdout } = await execFileAsync('git', ['show', `${ref}:${repoPath}`], {
      cwd: realToplevel,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, text: stdout };
  } catch (e) {
    const message = (e as { stderr?: string; message?: string }).stderr?.trim() || (e as Error).message;
    return { ok: false, error: `git show ${ref}:${repoPath} failed: ${message}` };
  }
}

function guessFormat(source: string): 'json' | 'yaml' | 'unknown' {
  const lower = source.split(/[?#]/)[0]?.toLowerCase() ?? '';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'yaml';
  return 'unknown';
}

export type ParseResult = { ok: true; raw: Json } | { ok: false; error: string };

/**
 * JSON or YAML, decided by the source's extension where there is one, and by
 * sniffing the first non-whitespace character otherwise — `{`/`[` reads as
 * JSON, anything else as YAML. A source whose extension says one format is
 * only ever tried as that format: a `.json` file that is not JSON is a parse
 * error, not a surprise YAML interpretation of it.
 */
export function parseSpecText(source: string, text: string): ParseResult {
  const asJson = (): ParseResult => {
    try {
      return { ok: true, raw: JSON.parse(text) };
    } catch (e) {
      return { ok: false, error: `${source} is not valid JSON: ${(e as Error).message}` };
    }
  };
  const asYaml = (): ParseResult => {
    try {
      return { ok: true, raw: parseYaml(text) };
    } catch (e) {
      const message = e instanceof YamlParseError ? e.message : `could not parse YAML: ${(e as Error).message}`;
      return { ok: false, error: `${source} is not valid YAML: ${message}` };
    }
  };

  const hint = guessFormat(source);
  if (hint === 'json') return asJson();
  if (hint === 'yaml') return asYaml();

  const trimmed = text.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const json = asJson();
    if (json.ok) return json;
  }
  const yaml = asYaml();
  if (yaml.ok) return yaml;
  const json = asJson();
  if (json.ok) return json;
  return { ok: false, error: `${source} could not be parsed as JSON or YAML: ${yaml.error}` };
}

const METHOD_KEYS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

/**
 * Swagger 2.0 → the shape `spec.ts` already reads (OpenAPI 3.x's
 * `requestBody`/`responses[code].content`), so the rest of the engine does
 * not need a second reader. `$ref`s are left untouched — `#/definitions/Foo`
 * still resolves, because only `paths` is rebuilt and `definitions` moves
 * with the rest of the document unchanged.
 *
 * Only the `body` parameter is translated into a request body. `formData`
 * parameters (multipart/url-encoded submissions) are left as ordinary
 * parameters rather than synthesised into a request body schema — they are
 * rare in the Swagger 2.0 documents this has been run against, and a
 * synthesised schema the vendor never wrote is a guess this reader would
 * rather not make silently.
 */
export function normalizeSwagger2(raw: Json): Json {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.swagger !== '2.0') return raw;
  const paths = raw.paths;
  if (!paths || typeof paths !== 'object' || Array.isArray(paths)) return raw;

  const globalConsumes = Array.isArray(raw.consumes) && raw.consumes.length > 0 ? raw.consumes : ['application/json'];
  const globalProduces = Array.isArray(raw.produces) && raw.produces.length > 0 ? raw.produces : ['application/json'];

  const newPaths: Record<string, Json> = {};
  for (const [path, pathItem] of Object.entries(paths as Record<string, Json>)) {
    if (!pathItem || typeof pathItem !== 'object' || Array.isArray(pathItem)) {
      newPaths[path] = pathItem;
      continue;
    }
    const newPathItem: Record<string, Json> = { ...pathItem };
    const pathParams: Json[] = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
    if (Array.isArray(pathItem.parameters)) {
      // Path-item-level parameters are inherited by every operation on the
      // path (spec.ts's `parameters()` reads them the same way), so a
      // non-body one needs the same schema synthesis as an operation-level
      // one. A $ref entry is resolved first — against the ORIGINAL document,
      // same as everywhere else in this function — so a shared
      // `#/parameters/Name` parameter is synthesized too; an entry that
      // fails to resolve is left as-is, to be reported unresolved at read
      // time exactly as it already is.
      newPathItem.parameters = pathItem.parameters.map((p: Json) => {
        const resolved = resolveSwagger2Value(p, raw);
        return withSynthesizedSchema(resolved.node ?? p);
      });
    }
    for (const method of METHOD_KEYS) {
      const op = (pathItem as Record<string, Json>)[method];
      if (!op || typeof op !== 'object' || Array.isArray(op)) continue;
      newPathItem[method] = normalizeOperation(op, pathParams, globalConsumes, globalProduces, raw);
    }
    newPaths[path] = newPathItem;
  }
  return { ...raw, paths: newPaths };
}

/**
 * `value` resolved if it is a local `$ref`, using the SAME dereferencer
 * `spec.ts` uses at read time (`deref`), against the ORIGINAL raw document —
 * so a Swagger 2.0 `#/parameters/Name` or `#/responses/Name` reference
 * resolves exactly as reliably as any other local ref, rather than through a
 * bespoke single-segment resolver. `value` itself when it is not a `$ref` at
 * all. `{ node: undefined, unresolved: reason }` when it IS a `$ref` but
 * could not be resolved — the caller must not guess at what an unresolved
 * ref might have meant, and must say so rather than silently proceed as if
 * nothing were there.
 */
function resolveSwagger2Value(value: Json, originalDoc: Json): { node: Json; unresolved?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.$ref !== 'string') {
    return { node: value };
  }
  const resolved = deref(value, originalDoc);
  if (!resolved.ok) return { node: undefined, unresolved: resolved.reason };
  return { node: resolved.node };
}

/**
 * The Swagger 2.0 "Items Object" / parameter-level constraint keywords a
 * non-body parameter declares INLINE on itself — only `in: body` nests these
 * under a `schema` object, an OpenAPI 3 convention. `spec.ts`'s
 * `typeOfSchema`/`enumOfSchema` (called from `diff.ts` for every parameter,
 * via `ParamRef.schema`) only ever look at `.schema`, so a non-body
 * parameter's own constraints are otherwise invisible to them.
 */
const SWAGGER2_PARAM_SCHEMA_KEYS = [
  'type',
  'format',
  'items',
  'collectionFormat',
  'default',
  'maximum',
  'exclusiveMaximum',
  'minimum',
  'exclusiveMinimum',
  'maxLength',
  'minLength',
  'pattern',
  'maxItems',
  'minItems',
  'uniqueItems',
  'enum',
  'multipleOf',
] as const;

/**
 * Copies a non-body parameter's inline constraint keywords into a
 * synthesized `schema` object, so the rest of the engine reads it exactly
 * like an OpenAPI 3 parameter's `.schema` instead of silently seeing none of
 * it. Left untouched when the entry is not a plain object, is `in: body`
 * (whose `schema` is already the real thing), already declares its own
 * `schema` (nothing here to synthesize), or declares none of these keywords
 * at all (nothing to move).
 */
function withSynthesizedSchema(p: Json): Json {
  if (!p || typeof p !== 'object' || Array.isArray(p) || p.in === 'body' || p.schema !== undefined) return p;
  const schema: Record<string, Json> = {};
  let has = false;
  for (const key of SWAGGER2_PARAM_SCHEMA_KEYS) {
    if (p[key] !== undefined) {
      schema[key] = p[key];
      has = true;
    }
  }
  return has ? { ...p, schema } : p;
}

/** Marks an operation's request as not honestly convertible — read by `diff.ts` alongside `requestView`'s own `unknown`. */
export const UNRESOLVED_REQUEST_REF = 'x-apibreak-unresolved-request-ref';
/** Marks one response status as not honestly convertible — read by `diff.ts` alongside `responseView`'s own per-status `unknown`. */
export const UNRESOLVED_RESPONSE_REF = 'x-apibreak-unresolved-response-ref';

function normalizeOperation(op: Json, pathParams: Json[], globalConsumes: Json[], globalProduces: Json[], originalDoc: Json): Json {
  const consumes = Array.isArray(op.consumes) && op.consumes.length > 0 ? op.consumes : globalConsumes;
  const produces = Array.isArray(op.produces) && op.produces.length > 0 ? op.produces : globalProduces;
  const ownParamsRaw: Json[] = Array.isArray(op.parameters) ? op.parameters : [];
  const pathParamsRaw: Json[] = pathParams;

  // Resolve every `$ref` parameter entry BEFORE looking for the body
  // parameter or filtering it out: a $ref entry has no `in` property of its
  // own, so an unresolved one is invisible to both — a body parameter
  // declared once and shared by $ref would never become a requestBody, and
  // would never even be recognisable as the body parameter to exclude from
  // the ordinary parameter list. When a $ref fails to resolve, this
  // operation's true parameter set is not fully known — the unresolved
  // entry itself might have been the body parameter — so the request is
  // marked unresolved for the WHOLE operation rather than guessed at.
  let requestRefUnresolved: string | undefined;
  const resolveParam = (p: Json): Json => {
    const r = resolveSwagger2Value(p, originalDoc);
    if (r.unresolved !== undefined) requestRefUnresolved = requestRefUnresolved ?? r.unresolved;
    return r.node;
  };
  const ownParams = ownParamsRaw.map(resolveParam);
  const pathParamsResolved = pathParamsRaw.map(resolveParam);

  const ownBody = ownParams.find((p) => p && typeof p === 'object' && p.in === 'body');
  const bodyParam = ownBody ?? pathParamsResolved.find((p) => p && typeof p === 'object' && p.in === 'body');
  const nonBodyParams = ownParams.filter((p) => !p || typeof p !== 'object' || p.in !== 'body').map(withSynthesizedSchema);

  const newOp: Record<string, Json> = { ...op, parameters: nonBodyParams };

  if (bodyParam) {
    const content: Record<string, Json> = {};
    for (const contentType of consumes) content[String(contentType)] = { schema: bodyParam.schema };
    newOp.requestBody = { required: bodyParam.required === true, content };
  }
  if (requestRefUnresolved !== undefined) newOp[UNRESOLVED_REQUEST_REF] = requestRefUnresolved;

  const responses = op.responses;
  if (responses && typeof responses === 'object' && !Array.isArray(responses)) {
    const newResponses: Record<string, Json> = {};
    for (const [code, responseRaw] of Object.entries(responses as Record<string, Json>)) {
      // Resolve a `#/responses/Name` $ref BEFORE the schema->content
      // conversion below: an unresolved ref has no `schema` key of its own,
      // so leaving it unresolved would skip the conversion here and leave
      // the shared response's own `schema` (never converted, since this walk
      // only visits `paths`) to be diffed as a bare Swagger 2 shape instead
      // of `content` — or, worse, to resolve successfully but wrongly at
      // *read* time, against the aligned/re-keyed document, whose own
      // `#/responses/Name` still points at the un-converted original.
      const resolved = resolveSwagger2Value(responseRaw, originalDoc);
      if (resolved.unresolved !== undefined) {
        newResponses[code] = { [UNRESOLVED_RESPONSE_REF]: resolved.unresolved };
        continue;
      }
      const response = resolved.node;
      if (response && typeof response === 'object' && !Array.isArray(response) && 'schema' in response) {
        const content: Record<string, Json> = {};
        for (const contentType of produces) content[String(contentType)] = { schema: response.schema };
        newResponses[code] = { ...response, content };
      } else {
        newResponses[code] = response;
      }
    }
    newOp.responses = newResponses;
  }

  return newOp;
}

/** Text in, an indexed `SpecDoc` out: parse, normalize Swagger 2.0, index. */
export function docFromText(source: string, text: string): DocResult {
  const parsed = parseSpecText(source, text);
  if (!parsed.ok) return parsed;
  const raw = normalizeSwagger2(parsed.raw);
  return { ok: true, doc: indexSpec(raw), raw };
}

/** The full pipeline for one CLI argument: read, parse, normalize, index. */
export async function loadSpec(source: string, fetchImpl: typeof fetch): Promise<DocResult> {
  const text = await readSpecText(source, fetchImpl);
  if (!text.ok) return text;
  return docFromText(source, text.text);
}
