/**
 * Reading API calls out of hand-written Markdown and MDX — the extraction half
 * of `apibreak docs`. Nothing here knows about the spec; `docs-check.ts`
 * decides what a reference means.
 *
 * Five shapes are read:
 *
 *   - `curl` commands in shell-ish fenced blocks,
 *   - raw HTTP requests (`GET /v1/x HTTP/1.1`, headers, JSON body),
 *   - JavaScript/TypeScript `fetch(url, { method, body: JSON.stringify({...}) })`,
 *   - Python `requests.<method>(url, json=..., params=..., data=...)` (and `httpx`),
 *   - inline prose like `GET /v1/customers/{id}`.
 *
 * The rule throughout is the product's: never guess. A call that is clearly
 * an API call but cannot be read with confidence — the URL is a variable, the
 * method is computed, two things look like URLs — is returned as `unparsed`
 * with a reason, and the report counts it. It is never turned into a finding.
 * A call whose method and URL are clear but whose body is not (`-d @file.json`,
 * `JSON.stringify(payload)`) is kept, with its body marked unread, so the
 * endpoint and method are still checked and no body finding is invented.
 */

import { METHODS, type Method } from './types.js';

export type ReferenceSource = 'curl' | 'http' | 'fetch' | 'python' | 'prose';

export interface BodyRef {
  encoding: 'json' | 'form' | 'multipart' | 'unknown';
  /** Top-level keys sent, or null when the body could not be read. */
  keys: string[] | null;
  /**
   * True only when `keys` is every key the example sends: no spread, no
   * computed key, no part read from a file. A required-field finding needs it.
   */
  complete: boolean;
  /** Why `keys` is null. */
  unread?: string;
}

export interface DocReference {
  file: string;
  /** 1-based line of the call (its first line, for a multi-line call). */
  line: number;
  source: ReferenceSource;
  /** One line of the original text, for the report. */
  snippet: string;
  method: Method;
  /** The URL or path as written, placeholders and variables intact, query included. */
  url: string;
  /** Query parameter names from the URL and from `params=`/`-G` data; null when none are sent. */
  query: string[] | null;
  /** Set when part of the query string could not be read: a variable stands in for a whole parameter. */
  queryUnread?: string;
  body: BodyRef | null;
}

export interface UnparsedReference {
  file: string;
  line: number;
  source: ReferenceSource;
  snippet: string;
  reason: string;
}

export interface ScanResult {
  references: DocReference[];
  unparsed: UnparsedReference[];
  /** References skipped because an `apibreak-ignore` marker covers them. */
  suppressed: number;
  /** True when the file carries `apibreak-ignore-file`. */
  ignoredFile: boolean;
}

const METHOD_SET = new Set<string>(METHODS);
const isMethod = (m: string): m is Method => METHOD_SET.has(m);

export function snippetOf(text: string, max = 140): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export interface QueryRead {
  /** Query parameter names read, or null when none were. */
  keys: string[] | null;
  /** Set when some part of the query string could not be read at all — a bare variable standing in for a whole parameter, rather than a literal `name=value` pair. */
  unread?: string;
}

/**
 * Query parameter names in a URL's query string. A `name=value` pair whose
 * name is itself a placeholder (`{id}=2`) is dropped silently — a documented
 * parameter whose own name is a template value is unusual but not a sign
 * anything else is missing. A bare token with no `=` at all that is clearly a
 * variable (`$FILTER`, `{qs}`, the stringified expression a template
 * substitution leaves behind) is different: it stands in for a whole
 * parameter — or more than one — this check cannot see, so it is reported as
 * `unread` rather than silently dropped like the other case.
 */
export function queryOf(url: string): QueryRead {
  const q = url.indexOf('?');
  if (q === -1) return { keys: null };
  const query = url.slice(q + 1).split('#')[0] ?? '';
  const keys: string[] = [];
  let unread: string | undefined;
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq === -1 && /[{}<>$]/.test(pair)) {
      unread = unread ?? `the query string includes a variable ("${pair}") this check cannot read`;
      continue;
    }
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    let key: string;
    try {
      key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
    } catch {
      key = rawKey;
    }
    // `?{param}=x` — a placeholder standing in for a NAME, not a name.
    if (!key || /[{}<>$]/.test(key)) continue;
    keys.push(key);
  }
  return { keys: keys.length > 0 ? keys : null, ...(unread ? { unread } : {}) };
}

/** Query parameter names in a URL's query string, or null when it has none. */
export function queryKeysOf(url: string): string[] | null {
  return queryOf(url).keys;
}

/** Top-level keys of `a=1&b[c]=2` form data. */
function formKeys(data: string): string[] {
  const keys: string[] = [];
  for (const pair of data.split('&')) {
    if (!pair) continue;
    const rawKey = pair.split('=')[0] ?? '';
    let key: string;
    try {
      key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
    } catch {
      key = rawKey;
    }
    if (key) keys.push(key);
  }
  return keys;
}

/** A JSON body's top-level keys, or why there are none to check. */
function jsonBody(text: string): BodyRef {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { encoding: 'json', keys: null, complete: false, unread: 'the body is not valid JSON (placeholders, comments or an ellipsis)' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { encoding: 'json', keys: null, complete: false, unread: 'the body is not a JSON object' };
  }
  return { encoding: 'json', keys: Object.keys(parsed), complete: true };
}

// ---------------------------------------------------------------- Markdown --

export interface CodeBlock {
  lang: string;
  /** 1-based line of the block's first content line. */
  startLine: number;
  lines: string[];
  suppressed: boolean;
}

interface ProseLine {
  line: number;
  text: string;
  suppressed: boolean;
}

// Only a whole comment — not a substring of ordinary prose or a URL — ever
// suppresses anything: `GET /apibreak-ignore-filed` must not silently
// suppress the whole file just because the marker's text appears inside it.
const COMMENT_FORM = (name: string): RegExp =>
  new RegExp(String.raw`<!--\s*${name}\s*-->|\{\/\*\s*${name}\s*\*\/\}`);
const IGNORE_FILE = COMMENT_FORM('apibreak-ignore-file');
const IGNORE = COMMENT_FORM('apibreak-ignore');

/**
 * Splits Markdown/MDX into fenced code blocks and prose lines. Front matter,
 * HTML comments and MDX `{/* *\/}` comments are not prose. An
 * `apibreak-ignore` marker on a line of its own (in any comment) suppresses the
 * next non-blank line, or the whole next fenced block; on a line with other
 * text it suppresses that line.
 */
export function splitMarkdown(text: string): { blocks: CodeBlock[]; prose: ProseLine[]; ignoredFile: boolean } {
  const lines = text.split(/\r?\n/);
  const blocks: CodeBlock[] = [];
  const prose: ProseLine[] = [];
  if (IGNORE_FILE.test(text)) return { blocks, prose, ignoredFile: true };

  let i = 0;
  if (lines[0]?.trim() === '---') {
    for (i = 1; i < lines.length; i++) {
      if (lines[i]!.trim() === '---' || lines[i]!.trim() === '...') {
        i += 1;
        break;
      }
    }
  }

  let pendingIgnore = false;
  let inHtmlComment = false;
  let inMdxComment = false;
  for (; i < lines.length; i++) {
    const raw = lines[i]!;
    const fence = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(raw);
    if (!inHtmlComment && !inMdxComment && fence && !(fence[2]![0] === '`' && fence[3]!.includes('`'))) {
      const indent = fence[1]!.length;
      const marker = fence[2]!;
      const info = fence[3]!.trim();
      const lang = (info.split(/\s+/)[0] ?? '').replace(/^[{.]+/, '').split(/[{}:,=]/)[0]!.toLowerCase();
      const startLine = i + 2;
      const content: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const close = /^(\s*)(`{3,}|~{3,})\s*$/.exec(lines[j]!);
        if (close && close[2]![0] === marker[0] && close[2]!.length >= marker.length) break;
        const l = lines[j]!;
        // Content of an indented fence (inside a list item) loses up to the fence's own indent.
        const strip = Math.min(indent, l.length - l.trimStart().length);
        content.push(l.slice(strip));
      }
      blocks.push({ lang, startLine, lines: content, suppressed: pendingIgnore });
      pendingIgnore = false;
      i = j;
      continue;
    }

    // Comments — HTML or MDX, each possibly spanning several lines — are not
    // rendered prose; a marker inside one still counts. Both forms are
    // tracked across lines the same way, so a multi-line comment never leaks
    // its interior as prose and line numbers of what follows stay correct.
    let visible = '';
    let rest = raw;
    while (rest.length > 0) {
      if (inHtmlComment) {
        const end = rest.indexOf('-->');
        if (end === -1) {
          rest = '';
        } else {
          inHtmlComment = false;
          rest = rest.slice(end + 3);
        }
      } else if (inMdxComment) {
        const end = rest.indexOf('*/}');
        if (end === -1) {
          rest = '';
        } else {
          inMdxComment = false;
          rest = rest.slice(end + 3);
        }
      } else {
        const htmlStart = rest.indexOf('<!--');
        const mdxStart = rest.indexOf('{/*');
        if (htmlStart === -1 && mdxStart === -1) {
          visible += rest;
          rest = '';
        } else if (mdxStart === -1 || (htmlStart !== -1 && htmlStart <= mdxStart)) {
          visible += rest.slice(0, htmlStart);
          rest = rest.slice(htmlStart + 4);
          inHtmlComment = true;
        } else {
          visible += rest.slice(0, mdxStart);
          rest = rest.slice(mdxStart + 3);
          inMdxComment = true;
        }
      }
    }

    const marked = IGNORE.test(raw);
    if (visible.trim() === '') {
      if (marked) pendingIgnore = true;
      continue;
    }
    prose.push({ line: i + 1, text: visible, suppressed: marked || pendingIgnore });
    pendingIgnore = false;
  }
  return { blocks, prose, ignoredFile: false };
}

// ------------------------------------------------------------------- prose --

const PATH_CHARS = String.raw`(?:<[A-Za-z_][\w.-]*>|[^\s\`'"()\[\]|<>*])`;
const PROSE_RE = new RegExp(
  String.raw`(?<![A-Za-z0-9_/.-])(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)[ \t]+((?:https?://|/)${PATH_CHARS}*)`,
  'g'
);

/** `METHOD /path` mentions in one line of prose. */
export function proseReferences(text: string): Array<{ method: Method; url: string; snippet: string }> {
  const out: Array<{ method: Method; url: string; snippet: string }> = [];
  for (const m of text.matchAll(PROSE_RE)) {
    const method = m[1]!;
    // Sentence punctuation and emphasis markers are not part of a path.
    const url = m[2]!.replace(/[.,;:!?_~]+$/, '');
    if (!isMethod(method) || url === '' || url === 'https://' || url === 'http://') continue;
    out.push({ method, url, snippet: `${method} ${url}` });
  }
  return out;
}

// --------------------------------------------------------------------- curl --

const SHELL_LANGS = new Set(['', 'bash', 'sh', 'shell', 'zsh', 'console', 'terminal', 'curl', 'shellsession', 'shell-session', 'cmd', 'bat', 'powershell', 'ps', 'ps1', 'pwsh', 'text', 'txt', 'plaintext', 'sh-session', 'fish']);
const POWERSHELL_LANGS = new Set(['powershell', 'ps1', 'pwsh', 'ps']);
const HTTP_LANGS = new Set(['http', 'rest', 'restclient', 'httpspec', 'request']);
const JS_LANGS = new Set(['js', 'javascript', 'ts', 'typescript', 'jsx', 'tsx', 'mjs', 'cjs', 'node', 'mts']);
const PY_LANGS = new Set(['py', 'python', 'python3', 'py3', 'ipython', 'pycon']);

/** Index of the next backtick at or after `from` that is not backslash-escaped, or -1. */
function closingBacktick(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === '\\') i += 1;
    else if (s[i] === '`') return i;
  }
  return -1;
}

/** What a paired `...` command substitution stands for: its output is unknown, so it reads as a placeholder. */
export const SUBSTITUTION = '{cmd}';

/**
 * Shell words of one command, up to the first unquoted `|`, `;`, `&&`, `||`,
 * `)`, redirect or comment. Quotes are removed and adjacent pieces joined, as
 * a shell would; `$VAR` is left as text, a backtick substitution becomes
 * SUBSTITUTION. `heredoc` is set when the command reads a here-document,
 * whose contents are not followed. `powershell`: the backtick is an escape.
 */
export function shellWords(cmd: string, opts: { powershell?: boolean } = {}): { words: string[]; heredoc: boolean } {
  const words: string[] = [];
  let cur = '';
  let has = false;
  let heredoc = false;
  let i = 0;
  const push = (): void => {
    if (has) words.push(cur);
    cur = '';
    has = false;
  };
  while (i < cmd.length) {
    const c = cmd[i]!;
    if (c === "'") {
      const end = cmd.indexOf("'", i + 1);
      cur += end === -1 ? cmd.slice(i + 1) : cmd.slice(i + 1, end);
      has = true;
      i = end === -1 ? cmd.length : end + 1;
      continue;
    }
    if (c === '$' && cmd[i + 1] === "'") {
      const end = cmd.indexOf("'", i + 2);
      cur += (end === -1 ? cmd.slice(i + 2) : cmd.slice(i + 2, end)).replace(/\\n/g, '\n').replace(/\\(.)/g, '$1');
      has = true;
      i = end === -1 ? cmd.length : end + 1;
      continue;
    }
    if (c === '"') {
      i += 1;
      while (i < cmd.length && cmd[i] !== '"') {
        if (cmd[i] === '\\' && i + 1 < cmd.length && '"\\$`\n'.includes(cmd[i + 1]!)) {
          cur += cmd[i + 1];
          i += 2;
          continue;
        }
        if (opts.powershell && cmd[i] === '`' && i + 1 < cmd.length) {
          cur += cmd[i + 1];
          i += 2;
          continue;
        }
        // A substitution inside double quotes is still one: an unknown value.
        const close = cmd[i] === '`' && !opts.powershell ? closingBacktick(cmd, i + 1) : -1;
        if (close !== -1) {
          cur += SUBSTITUTION;
          i = close + 1;
          continue;
        }
        cur += cmd[i];
        i += 1;
      }
      has = true;
      i += 1;
      continue;
    }
    if (c === '\\' && i + 1 < cmd.length) {
      cur += cmd[i + 1];
      has = true;
      i += 2;
      continue;
    }
    if (/\s/.test(c)) {
      push();
      i += 1;
      continue;
    }
    if (c === '#' && !has) break;
    if (c === '<') {
      // `<invitation_id>` is a docs placeholder, not a redirect: read as one,
      // its `>` cut the URL short and dropped every option after it (`-X POST`).
      const placeholder = /^<[A-Za-z_][\w.-]*>/.exec(cmd.slice(i));
      if (placeholder) {
        cur += placeholder[0];
        has = true;
        i += placeholder[0].length;
        continue;
      }
      if (cmd[i + 1] === '<') {
        heredoc = true;
        break;
      }
    }
    // PowerShell's escape character is the backtick (`&, `"), not a substitution.
    if (c === '`' && opts.powershell) {
      if (i + 1 < cmd.length) cur += cmd[i + 1];
      has = true;
      i += 2;
      continue;
    }
    if (c === '`') {
      // A paired `...` is a command substitution whose output is unknown: a
      // placeholder, never its own text read as path segments. An unpaired
      // one closes the inline code span or substitution the command was
      // quoted in (`curl http://host/health`): the end.
      const end = closingBacktick(cmd, i + 1);
      if (end === -1) break;
      cur += SUBSTITUTION;
      has = true;
      i = end + 1;
      continue;
    }
    if (c === '|' || c === ';' || c === ')' || c === '>' || (c === '&' && cmd[i + 1] === '&')) break;
    cur += c;
    has = true;
    i += 1;
  }
  push();
  return { words, heredoc };
}

/** Short curl options that take a value. */
const CURL_SHORT_WITH_ARG = new Set('XdHuoAebcFmwxKTErCyYzUQt'.split(''));
/** Long curl options that take a value (the ones docs actually use, plus the common transport ones). */
const CURL_LONG_WITH_ARG = new Set([
  'request', 'data', 'data-raw', 'data-binary', 'data-ascii', 'data-urlencode', 'json', 'header', 'user', 'output',
  'user-agent', 'referer', 'cookie', 'cookie-jar', 'form', 'form-string', 'max-time', 'connect-timeout', 'write-out',
  'retry', 'retry-delay', 'retry-max-time', 'cacert', 'capath', 'cert', 'cert-type', 'key', 'key-type', 'proxy',
  'proxy-user', 'config', 'resolve', 'url', 'upload-file', 'oauth2-bearer', 'range', 'continue-at', 'limit-rate',
  'max-redirs', 'interface', 'dns-servers', 'unix-socket', 'aws-sigv4', 'variable', 'expand-data', 'ciphers',
  'tls-max', 'connect-to', 'pinnedpubkey', 'quote', 'trace', 'trace-ascii', 'stderr', 'max-filesize', 'local-port',
  'netrc-file', 'service-name', 'login-options', 'preproxy', 'socks5', 'socks5-hostname', 'user-agent', 'telnet-option',
]);

/** Does this word look like the URL of the request? */
export function looksLikeUrl(word: string): boolean {
  return (
    /^https?:\/\//i.test(word) ||
    /^\/[^/]/.test(word) ||
    word === '/' ||
    /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?(\/|$)/.test(word) ||
    /^\{\{\s*[\w.-]+\s*\}\}/.test(word) ||
    /^<[^>]+>\//.test(word) ||
    /^(?:localhost|[\w-]+(?:\.[\w-]+)+)(?::\d+)?\//i.test(word)
  );
}

type Parsed = { ok: true; ref: Omit<DocReference, 'file' | 'line' | 'source' | 'snippet'> } | { ok: false; reason: string };

/** One curl command's words (starting at `curl`) → a reference. */
export function parseCurl(words: string[], heredoc = false): Parsed {
  let method: string | undefined;
  let head = false;
  let get = false;
  const urls: string[] = [];
  const data: Array<{ kind: 'data' | 'urlencode' | 'json'; value: string }> = [];
  const form: string[] = [];
  let contentType: string | undefined;
  let uploadFile: string | undefined;

  const take = (name: string, value: string): void => {
    switch (name) {
      case 'X':
      case 'request':
        method = value;
        break;
      case 'T':
      case 'upload-file':
        uploadFile = value;
        break;
      case 'd':
      case 'data':
      case 'data-raw':
      case 'data-binary':
      case 'data-ascii':
        data.push({ kind: 'data', value });
        break;
      case 'data-urlencode':
        data.push({ kind: 'urlencode', value });
        break;
      case 'json':
        data.push({ kind: 'json', value });
        break;
      case 'F':
      case 'form':
      case 'form-string':
        form.push(value);
        break;
      case 'H':
      case 'header': {
        const h = /^\s*content-type\s*:\s*(.+)$/i.exec(value);
        if (h) contentType = h[1]!.trim().toLowerCase();
        break;
      }
      case 'url':
        urls.push(value);
        break;
      default:
        break;
    }
  };

  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    if (w.startsWith('--') && w.length > 2) {
      const eq = w.indexOf('=');
      const name = eq === -1 ? w.slice(2) : w.slice(2, eq);
      if (name === 'get') get = true;
      else if (name === 'head') head = true;
      if (CURL_LONG_WITH_ARG.has(name)) {
        const value = eq === -1 ? words[++i] : w.slice(eq + 1);
        if (value === undefined) return { ok: false, reason: `--${name} has no value` };
        take(name, value);
      }
      continue;
    }
    if (w.startsWith('-') && w.length > 1) {
      for (let k = 1; k < w.length; k++) {
        const ch = w[k]!;
        if (ch === 'G') get = true;
        if (ch === 'I') head = true;
        if (CURL_SHORT_WITH_ARG.has(ch)) {
          const value = k + 1 < w.length ? w.slice(k + 1) : words[++i];
          if (value === undefined) return { ok: false, reason: `-${ch} has no value` };
          take(ch, value);
          break;
        }
      }
      continue;
    }
    if (looksLikeUrl(w)) urls.push(w);
  }

  if (urls.length === 0) return { ok: false, reason: 'no URL could be identified' };
  if (urls.length > 1) return { ok: false, reason: `more than one argument looks like a URL (${urls.slice(0, 2).join(', ')})` };
  const url = urls[0]!;

  const sendsData = data.length > 0 || form.length > 0;
  let m: string;
  if (method !== undefined) {
    m = method.toUpperCase();
    if (!isMethod(m)) return { ok: false, reason: `the method "${method}" is not a literal HTTP method` };
  } else if (head) {
    m = 'HEAD';
  } else if (get) {
    m = 'GET';
  } else if (uploadFile !== undefined) {
    // -T/--upload-file PUTs the named file's contents as the body.
    m = 'PUT';
  } else {
    m = sendsData ? 'POST' : 'GET';
  }

  const urlQuery = queryOf(url);
  let query = urlQuery.keys;
  const queryUnread = urlQuery.unread;
  let body: BodyRef | null = null;

  if (form.length > 0) {
    body = {
      encoding: 'multipart',
      keys: form.map((f) => f.split('=')[0]!).filter((k) => k !== ''),
      complete: form.every((f) => f.includes('=')),
    };
  } else if (data.length > 0) {
    const fromFile = data.find((d) => d.value.startsWith('@') || (d.kind === 'urlencode' && /^[^=]*@/.test(d.value) && !d.value.includes('=')));
    const looksJson = data.some((d) => d.kind === 'json' || /^\s*[[{]/.test(d.value));
    if (heredoc || fromFile) {
      body = {
        encoding: looksJson || contentType?.includes('json') ? 'json' : 'unknown',
        keys: null,
        complete: false,
        unread: heredoc ? 'the body comes from a here-document' : `the body is read from a file (${fromFile!.value})`,
      };
    } else if (looksJson) {
      body =
        data.length === 1
          ? jsonBody(data[0]!.value)
          : { encoding: 'json', keys: null, complete: false, unread: 'more than one data argument with a JSON body' };
    } else {
      const keys: string[] = [];
      let complete = true;
      for (const d of data) {
        if (d.kind === 'urlencode') {
          const eq = d.value.indexOf('=');
          const at = d.value.indexOf('@');
          if (eq > 0 && (at === -1 || eq < at)) keys.push(d.value.slice(0, eq));
          else if (at > 0) keys.push(d.value.slice(0, at));
          else complete = false;
        } else if (d.value.includes('=')) {
          keys.push(...formKeys(d.value));
        } else {
          complete = false;
        }
      }
      body = complete
        ? { encoding: 'form', keys, complete: true }
        : { encoding: 'form', keys: null, complete: false, unread: 'a data argument is not key=value form data' };
    }
    if (get && body) {
      // -G sends the data as the query string; there is no body.
      if (body.keys) query = [...(query ?? []), ...body.keys];
      body = null;
    }
  }
  if (uploadFile !== undefined && body === null) {
    body = { encoding: 'unknown', keys: null, complete: false, unread: `the body is uploaded from a file (${uploadFile})` };
  }

  return { ok: true, ref: { method: m as Method, url, query, ...(queryUnread ? { queryUnread } : {}), body } };
}

/** Logical lines (backslash, or PowerShell backtick, continuations joined) with their first physical line. */
function logicalLines(lines: string[], lang: string): Array<{ text: string; offset: number }> {
  const out: Array<{ text: string; offset: number }> = [];
  const cont = POWERSHELL_LANGS.has(lang) ? /[`\\]\s*$/ : /\\\s*$/;
  let buf = '';
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (start === -1) start = i;
    if (cont.test(l)) {
      buf += `${l.replace(cont, '')} `;
      continue;
    }
    buf += l;
    out.push({ text: buf, offset: start });
    buf = '';
    start = -1;
  }
  if (start !== -1) out.push({ text: buf, offset: start });
  return out;
}

/**
 * `line` with every single- or double-quoted region blanked out (spaces,
 * same length, so indices into the ORIGINAL line still line up). A `;`,
 * `&`, `|` or `curl` inside a quoted string is shell text, not a command
 * separator or a command name — `echo "; curl /removed"` is one command,
 * not two — so the command-position search below must never see it.
 */
function maskShellQuotes(line: string, powershell = false): string {
  let out = '';
  let i = 0;
  while (i < line.length) {
    const c = line[i]!;
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      const stop = end === -1 ? line.length : end + 1;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < line.length && line[j] !== '"') {
        j += (line[j] === '\\' || (powershell && line[j] === '`')) && j + 1 < line.length ? 2 : 1;
      }
      const stop = j < line.length ? j + 1 : line.length;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function curlInBlock(block: CodeBlock): Array<{ offset: number; snippet: string; parsed: Parsed }> {
  const out: Array<{ offset: number; snippet: string; parsed: Parsed }> = [];
  const powershell = POWERSHELL_LANGS.has(block.lang);
  for (const { text, offset } of logicalLines(block.lines, block.lang)) {
    // A prompt (`$ `, `% `, `> `, `PS> `) is not part of the command.
    const line = text.replace(/^\s*(?:PS[^>]*>|[$%>])\s+/, '');
    if (/^\s*#/.test(line)) continue;
    // `curl` in command position: line start, after `|`, `;`, `&&`, `$(`, a
    // backtick, or a wrapper like `sudo`/`time`. Not the word inside a
    // string — matched against the quote-masked line so a separator or
    // `curl` spelled out inside quotes is invisible to this search; the
    // ORIGINAL line (same indices) is still what gets parsed.
    const re = /(?:^\s*|[;&|]\s*|\$\(\s*|`\s*|\b(?:sudo|time|exec|then|do|xargs)\s+)(curl(?:\.exe)?)(?=\s|$)/g;
    const masked = maskShellQuotes(line, powershell);
    for (const m of masked.matchAll(re)) {
      const at = (m.index ?? 0) + m[0].indexOf(m[1]!);
      // Opened by a backtick (`curl …` inline, or a substitution): it ends at
      // the matching close — the next unescaped backtick, or for a ``double``
      // code span the next run of the same length (a lone backtick inside is text).
      const run = /`+$/.exec(line.slice(0, at).replace(/\s+$/, ''))?.[0].length ?? 0;
      let close = -1;
      if (run === 1 && !powershell) {
        close = closingBacktick(line, at);
      } else if (run > 1) {
        const delimiter = new RegExp(`(?<!\`)\`{${run}}(?!\`)`, 'g');
        delimiter.lastIndex = at;
        close = delimiter.exec(line)?.index ?? -1;
      }
      const { words, heredoc } = shellWords(close === -1 ? line.slice(at) : line.slice(at, close), { powershell });
      if (words.length < 2) continue;
      out.push({ offset, snippet: snippetOf(line.slice(at)), parsed: parseCurl(words, heredoc) });
    }
  }
  return out;
}

// --------------------------------------------------------------------- HTTP --

const REQUEST_LINE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)(?:\s+HTTP\/[\d.]+)?\s*$/;

/** One raw HTTP request (request line, headers, blank line, body) → a reference. */
export function parseHttpRequest(lines: string[]): Parsed {
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first === -1) return { ok: false, reason: 'the block is empty' };
  const m = REQUEST_LINE.exec(lines[first]!.trim());
  if (!m) return { ok: false, reason: 'the first line is not an HTTP request line' };
  const method = m[1] as Method;
  let target = m[2]!;
  let host: string | undefined;
  let contentType: string | undefined;
  let i = first + 1;
  for (; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.trim() === '') break;
    const h = /^([A-Za-z0-9-]+)\s*:\s*(.*)$/.exec(l.trim());
    if (!h) break;
    const name = h[1]!.toLowerCase();
    if (name === 'host') host = h[2]!.trim();
    if (name === 'content-type') contentType = h[2]!.trim().toLowerCase();
  }
  if (host && target.startsWith('/')) target = `https://${host}${target}`;
  const bodyText = lines.slice(i + 1).join('\n').trim();
  let body: BodyRef | null = null;
  if (bodyText !== '') {
    if (contentType?.includes('x-www-form-urlencoded')) {
      body = { encoding: 'form', keys: formKeys(bodyText.replace(/\s+/g, '')), complete: true };
    } else if (/^[[{]/.test(bodyText) || contentType?.includes('json')) {
      body = jsonBody(bodyText);
    } else {
      body = { encoding: 'unknown', keys: null, complete: false, unread: 'the body is neither JSON nor form data' };
    }
  }
  const targetQuery = queryOf(target);
  return { ok: true, ref: { method, url: target, query: targetQuery.keys, ...(targetQuery.unread ? { queryUnread: targetQuery.unread } : {}), body } };
}

function httpInBlock(block: CodeBlock, explicit: boolean): Array<{ offset: number; snippet: string; parsed: Parsed }> {
  const out: Array<{ offset: number; snippet: string; parsed: Parsed }> = [];
  // REST Client files separate requests with `###`.
  let chunk: string[] = [];
  let chunkStart = 0;
  const flush = (): void => {
    const first = chunk.findIndex((l) => l.trim() !== '' && !/^\s*(#|\/\/)/.test(l));
    if (first !== -1) {
      const rest = chunk.slice(first);
      const head = rest[0]!.trim();
      // A response (`HTTP/1.1 200 OK`) is not a call.
      if (!/^HTTP\/[\d.]+\s+\d{3}/.test(head)) {
        if (REQUEST_LINE.test(head)) {
          out.push({ offset: chunkStart + first, snippet: snippetOf(head), parsed: parseHttpRequest(rest) });
        } else if (explicit) {
          out.push({ offset: chunkStart + first, snippet: snippetOf(head), parsed: { ok: false, reason: 'the first line is not an HTTP request line' } });
        }
      }
    }
    chunk = [];
  };
  block.lines.forEach((l, i) => {
    if (/^###/.test(l)) {
      flush();
      chunkStart = i + 1;
      return;
    }
    chunk.push(l);
  });
  flush();
  return out;
}

// ------------------------------------------------- JS / Python call parsing --

interface Lang {
  /** Line comment start. */
  comment: string;
  python: boolean;
}

/**
 * Index just past the string literal starting at `i` (quote at `i`, or a
 * Python prefix like `f"`), or -1 when unterminated.
 */
function skipString(src: string, i: number, lang: Lang): number {
  let j = i;
  while (lang.python && /[rRbBfFuU]/.test(src[j]!)) j++;
  const q = src[j];
  if (q !== '"' && q !== "'" && q !== '`') return -1;
  if (lang.python && src.startsWith(q.repeat(3), j)) {
    const end = src.indexOf(q.repeat(3), j + 3);
    return end === -1 ? -1 : end + 3;
  }
  j += 1;
  let depth = 0;
  while (j < src.length) {
    const c = src[j]!;
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (q === '`' && c === '$' && src[j + 1] === '{') {
      depth += 1;
      j += 2;
      continue;
    }
    if (q === '`' && depth > 0 && c === '}') {
      depth -= 1;
      j += 1;
      continue;
    }
    if (c === q && depth === 0) return j + 1;
    if (c === '\n' && q !== '`') return -1;
    j += 1;
  }
  return -1;
}

const isStringStart = (src: string, i: number, lang: Lang): boolean =>
  src[i] === '"' || src[i] === "'" || (!lang.python && src[i] === '`') ||
  (lang.python && /^[rRbBfFuU]{1,2}["']/.test(src.slice(i, i + 3)) && !/[\w]/.test(src[i - 1] ?? ''));

/** Index of the bracket closing the one at `open`, skipping strings and comments; -1 when unbalanced. */
function matchBracket(src: string, open: number, lang: Lang): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const stack: string[] = [];
  let i = open;
  while (i < src.length) {
    const c = src[i]!;
    if (isStringStart(src, i, lang)) {
      const end = skipString(src, i, lang);
      if (end === -1) return -1;
      i = end;
      continue;
    }
    if (src.startsWith(lang.comment, i)) {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (!lang.python && src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (pairs[c]) stack.push(pairs[c]!);
    else if (c === ')' || c === ']' || c === '}') {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
    i += 1;
  }
  return -1;
}

/**
 * `src` with every comment blanked (and, when `strings`, every string literal
 * too), same length, newlines kept — so a finder regex never matches inside
 * either, and indices still point into the original text.
 */
function maskCode(src: string, lang: Lang, strings: boolean): string {
  let out = '';
  let i = 0;
  const blank = (t: string): string => t.replace(/[^\n]/g, ' ');
  while (i < src.length) {
    if (isStringStart(src, i, lang)) {
      const end = skipString(src, i, lang);
      const e = end === -1 ? src.length : end;
      out += strings ? blank(src.slice(i, e)) : src.slice(i, e);
      i = e;
      continue;
    }
    if (src.startsWith(lang.comment, i)) {
      const nl = src.indexOf('\n', i);
      const e = nl === -1 ? src.length : nl;
      out += blank(src.slice(i, e));
      i = e;
      continue;
    }
    if (!lang.python && src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      const e = end === -1 ? src.length : end + 2;
      out += blank(src.slice(i, e));
      i = e;
      continue;
    }
    out += src[i];
    i += 1;
  }
  return out;
}

/** Splits `src` on top-level commas (strings, brackets and comments respected). */
function splitTopLevel(src: string, lang: Lang): string[] {
  const parts: string[] = [];
  let start = 0;
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (isStringStart(src, i, lang)) {
      const end = skipString(src, i, lang);
      i = end === -1 ? src.length : end;
      continue;
    }
    if (src.startsWith(lang.comment, i)) {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      const end = matchBracket(src, i, lang);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    if (c === ',') {
      parts.push(src.slice(start, i));
      start = i + 1;
    }
    i += 1;
  }
  parts.push(src.slice(start));
  return parts.map((p) => maskCode(p, lang, false).trim()).filter((p) => p !== '');
}

/** The text of a plain string literal, or undefined when `expr` is anything else. */
function stringLiteral(expr: string, lang: Lang): string | undefined {
  const e = expr.trim();
  if (!isStringStart(e, 0, lang)) return undefined;
  const end = skipString(e, 0, lang);
  if (end !== e.length) return undefined;
  let j = 0;
  let isF = false;
  while (lang.python && /[rRbBfFuU]/.test(e[j]!)) {
    if (/[fF]/.test(e[j]!)) isF = true;
    j++;
  }
  const q = e[j]!;
  const triple = lang.python && e.startsWith(q.repeat(3), j);
  let inner = triple ? e.slice(j + 3, -3) : e.slice(j + 1, -1);
  // Template-literal and f-string substitutions become `{expr}` placeholders.
  if (q === '`') inner = inner.replace(/\$\{([^}]*)\}/g, '{$1}');
  else if (isF) inner = inner.replace(/\{\{/g, '\u0001').replace(/\}\}/g, '\u0002').replace(/\u0001/g, '{').replace(/\u0002/g, '}');
  return inner;
}

/**
 * A URL expression: a string literal (template/f-string placeholders kept as
 * `{expr}`), or `IDENT + "literal" (+ ...)` concatenation, where an identifier
 * becomes `{IDENT}` — a leading one reads as a base-URL variable.
 */
function urlExpression(expr: string, lang: Lang): string | undefined {
  const lit = stringLiteral(expr, lang);
  if (lit !== undefined) return lit;
  const parts = expr.split('+').map((p) => p.trim());
  if (parts.length < 2) return undefined;
  let out = '';
  for (const p of parts) {
    const s = stringLiteral(p, lang);
    if (s !== undefined) out += s;
    else if (/^[A-Za-z_$][\w$.]*$/.test(p)) out += `{${p}}`;
    else if (/^(?:str|String)\(\s*[A-Za-z_$][\w$.]*\s*\)$/.test(p)) out += '{value}';
    else return undefined;
  }
  return /[^{}]/.test(out.replace(/\{[^}]*\}/g, '')) ? out : undefined;
}

/** Top-level keys of an object/dict literal `{...}`; `complete` false on a spread or computed key. */
export function literalKeys(src: string, lang: Lang): { keys: string[]; complete: boolean } | undefined {
  const s = src.trim();
  if (!s.startsWith('{')) return undefined;
  const end = matchBracket(s, 0, lang);
  if (end !== s.length - 1) return undefined;
  const keys: string[] = [];
  let complete = true;
  for (const entry of splitTopLevel(s.slice(1, -1), lang)) {
    if (entry.startsWith('...') || entry.startsWith('**')) {
      complete = false;
      continue;
    }
    if (isStringStart(entry, 0, lang)) {
      const keyEnd = skipString(entry, 0, lang);
      const key = keyEnd === -1 ? undefined : stringLiteral(entry.slice(0, keyEnd), lang);
      if (key === undefined || !/^\s*:/.test(entry.slice(keyEnd)) || (lang.python && /^[fF]/.test(entry))) {
        complete = false;
        continue;
      }
      keys.push(key);
      continue;
    }
    if (lang.python) {
      // A dict key that is not a string literal (a variable, a constant) is not a name we can read.
      complete = false;
      continue;
    }
    const m = /^([A-Za-z_$][\w$]*)\s*(:|$|\()/.exec(entry);
    if (!m) {
      complete = false;
      continue;
    }
    keys.push(m[1]!);
  }
  return { keys, complete };
}

/** `dict(a=1, b=2)` → keys. */
function dictCallKeys(src: string, lang: Lang): { keys: string[]; complete: boolean } | undefined {
  const m = /^dict\s*\(/.exec(src.trim());
  if (!m) return undefined;
  const s = src.trim();
  const open = s.indexOf('(');
  const close = matchBracket(s, open, lang);
  if (close !== s.length - 1) return undefined;
  const keys: string[] = [];
  let complete = true;
  for (const arg of splitTopLevel(s.slice(open + 1, -1), lang)) {
    const k = /^([A-Za-z_]\w*)\s*=/.exec(arg);
    if (k) keys.push(k[1]!);
    else complete = false;
  }
  return { keys, complete };
}

function objectProps(src: string, lang: Lang): Map<string, string> | undefined {
  const s = src.trim();
  if (!s.startsWith('{') || matchBracket(s, 0, lang) !== s.length - 1) return undefined;
  const props = new Map<string, string>();
  for (const entry of splitTopLevel(s.slice(1, -1), lang)) {
    const m = /^(?:([A-Za-z_$][\w$]*)|"([^"]*)"|'([^']*)')\s*:\s*([\s\S]*)$/.exec(entry);
    if (m) props.set(m[1] ?? m[2] ?? m[3] ?? '', m[4]!.trim());
    else if (/^[A-Za-z_$][\w$]*$/.test(entry)) props.set(entry, entry);
    else props.set(`\u0000${props.size}`, entry);
  }
  return props;
}

/** `fetch(url, init)` → a reference. */
export function parseFetchArgs(args: string[]): Parsed {
  const lang: Lang = { comment: '//', python: false };
  const urlArg = args[0];
  if (urlArg === undefined) return { ok: false, reason: 'fetch() has no arguments' };
  const url = urlExpression(urlArg, lang);
  if (url === undefined) return { ok: false, reason: 'the URL is not a string literal' };
  let method: string = 'GET';
  let body: BodyRef | null = null;
  const init = args[1];
  if (init !== undefined) {
    const props = objectProps(init, lang);
    if (!props) return { ok: false, reason: 'the options argument is not an object literal' };
    // A spread may override method/body no matter where it sits relative to
    // them textually (object literals evaluate left to right, and a spread
    // can also sit BEFORE an explicit method/body and still be shadowed by
    // them, or AFTER and override them) — either way, this check cannot
    // tell what the options object actually ends up sending, so it refuses
    // regardless of whether method/body are also written out explicitly.
    const spread = [...props.values()].some((v) => v.startsWith('...'));
    if (spread) {
      return { ok: false, reason: 'the options object is spread from elsewhere, so the method or body may be set there' };
    }
    const m = props.get('method');
    if (m !== undefined) {
      const lit = stringLiteral(m, lang);
      if (lit === undefined) return { ok: false, reason: 'the method is not a string literal' };
      method = lit.toUpperCase();
      if (!isMethod(method)) return { ok: false, reason: `the method "${lit}" is not an HTTP method` };
    }
    const b = props.get('body');
    if (b !== undefined) {
      const stringify = /^JSON\.stringify\s*\(([\s\S]*)\)$/.exec(b);
      const params = /^new\s+URLSearchParams\s*\(([\s\S]*)\)$/.exec(b);
      const lit = stringLiteral(b, lang);
      if (stringify) {
        const inner = splitTopLevel(stringify[1]!, lang)[0] ?? '';
        const k = literalKeys(inner, lang);
        body = k ? { encoding: 'json', keys: k.keys, complete: k.complete } : { encoding: 'json', keys: null, complete: false, unread: 'JSON.stringify() is given a variable, not an object literal' };
      } else if (params) {
        const k = literalKeys(params[1]!, lang);
        body = k ? { encoding: 'form', keys: k.keys, complete: k.complete } : { encoding: 'form', keys: null, complete: false, unread: 'URLSearchParams is not built from an object literal' };
      } else if (lit !== undefined && /^\s*[[{]/.test(lit)) {
        body = jsonBody(lit);
      } else {
        body = { encoding: 'unknown', keys: null, complete: false, unread: 'the body is a variable or an expression' };
      }
    }
  }
  const urlQuery = queryOf(url);
  return { ok: true, ref: { method: method as Method, url, query: urlQuery.keys, ...(urlQuery.unread ? { queryUnread: urlQuery.unread } : {}), body } };
}

/** `requests.<method>(url, ...)` → a reference. `verb` is the method name, or "request" with the method as the first argument. */
export function parsePythonArgs(verb: string, args: string[]): Parsed {
  const lang: Lang = { comment: '#', python: true };
  const positional = args.filter((a) => !/^[A-Za-z_]\w*\s*=(?!=)/.test(a));
  const kw = new Map<string, string>();
  for (const a of args) {
    const m = /^([A-Za-z_]\w*)\s*=(?!=)\s*([\s\S]*)$/.exec(a);
    if (m) kw.set(m[1]!, m[2]!);
  }
  if (args.some((a) => a.startsWith('**'))) return { ok: false, reason: 'arguments are passed with **kwargs' };

  let method: string;
  let urlExpr: string | undefined;
  let urlPositionalIndex: number;
  if (verb === 'request') {
    const mExpr = positional[0] ?? kw.get('method');
    const lit = mExpr === undefined ? undefined : stringLiteral(mExpr, lang);
    if (lit === undefined) return { ok: false, reason: 'the method is not a string literal' };
    method = lit.toUpperCase();
    urlPositionalIndex = 1;
    urlExpr = positional[urlPositionalIndex] ?? kw.get('url');
  } else {
    method = verb.toUpperCase();
    urlPositionalIndex = 0;
    urlExpr = positional[urlPositionalIndex] ?? kw.get('url');
  }
  if (!isMethod(method)) return { ok: false, reason: `"${method}" is not an HTTP method` };
  if (urlExpr === undefined) return { ok: false, reason: 'no URL argument' };
  const url = urlExpression(urlExpr, lang);
  if (url === undefined) return { ok: false, reason: 'the URL is not a string literal' };

  const urlQuery = queryOf(url);
  let query = urlQuery.keys;
  let queryUnread = urlQuery.unread;
  const params = kw.get('params');
  if (params !== undefined) {
    const k = literalKeys(params, lang) ?? dictCallKeys(params, lang);
    if (k) query = [...(query ?? []), ...k.keys];
    else queryUnread = queryUnread ?? 'params= is a variable, not a dict literal';
  }

  let body: BodyRef | null = null;
  const json = kw.get('json');
  const kwData = kw.get('data');
  const files = kw.get('files');
  // requests/httpx accept the body as the second positional argument to
  // post/put/patch/request (`requests.post(url, data)`), not only as
  // `data=`; a literal dict there is read the same way `data=` already is.
  const positionalData = kwData === undefined && (verb === 'post' || verb === 'put' || verb === 'patch' || verb === 'request')
    ? positional[urlPositionalIndex + 1]
    : undefined;
  const data = kwData ?? positionalData;
  const dataIsPositional = kwData === undefined && positionalData !== undefined;
  if (json !== undefined) {
    const k = literalKeys(json, lang) ?? dictCallKeys(json, lang);
    body = k ? { encoding: 'json', keys: k.keys, complete: k.complete } : { encoding: 'json', keys: null, complete: false, unread: 'json= is a variable, not a dict literal' };
  } else if (data !== undefined) {
    const dumps = /^json\.dumps\s*\(([\s\S]*)\)$/.exec(data.trim());
    const target = dumps ? (splitTopLevel(dumps[1]!, lang)[0] ?? '') : data;
    const k = literalKeys(target, lang) ?? dictCallKeys(target, lang);
    const lit = stringLiteral(data, lang);
    if (k) body = { encoding: dumps ? 'json' : 'form', keys: k.keys, complete: k.complete && files === undefined };
    else if (lit !== undefined && /^\s*[[{]/.test(lit)) body = jsonBody(lit);
    else body = { encoding: 'unknown', keys: null, complete: false, unread: dataIsPositional ? 'the second positional argument is not a dict literal' : 'data= is a variable, not a dict literal' };
  } else if (files !== undefined) {
    body = { encoding: 'multipart', keys: null, complete: false, unread: 'files= uploads are not read' };
  }
  return { ok: true, ref: { method: method as Method, url, query, ...(queryUnread ? { queryUnread } : {}), body } };
}

function callsInCode(
  block: CodeBlock,
  lang: Lang,
  finder: RegExp,
  parse: (match: RegExpMatchArray, args: string[]) => Parsed
): Array<{ offset: number; snippet: string; parsed: Parsed }> {
  const src = block.lines.join('\n');
  const out: Array<{ offset: number; snippet: string; parsed: Parsed }> = [];
  // Matched against the masked text: a call inside a comment or a string is
  // not a call. Parsed from the original text at the same index.
  for (const m of maskCode(src, lang, true).matchAll(finder)) {
    const at = m.index ?? 0;
    const lineStart = src.lastIndexOf('\n', at) + 1;
    const open = at + m[0].length - 1;
    const close = matchBracket(src, open, lang);
    const offset = src.slice(0, at).split('\n').length - 1;
    const lineText = src.slice(lineStart, src.indexOf('\n', at) === -1 ? src.length : src.indexOf('\n', at));
    if (close === -1) {
      out.push({ offset, snippet: snippetOf(lineText), parsed: { ok: false, reason: 'the call could not be delimited' } });
      continue;
    }
    const args = splitTopLevel(src.slice(open + 1, close), lang);
    out.push({ offset, snippet: snippetOf(lineText), parsed: parse(m, args) });
  }
  return out;
}

// --------------------------------------------------------------- the scan --

/** Every API reference in one Markdown/MDX file. */
export function scanMarkdown(text: string, file: string): ScanResult {
  const { blocks, prose, ignoredFile } = splitMarkdown(text);
  const result: ScanResult = { references: [], unparsed: [], suppressed: 0, ignoredFile };
  if (ignoredFile) return result;

  const record = (source: ReferenceSource, line: number, snippet: string, parsed: Parsed, suppressed: boolean): void => {
    if (suppressed) {
      result.suppressed += 1;
      return;
    }
    if (parsed.ok) result.references.push({ file, line, source, snippet, ...parsed.ref });
    else result.unparsed.push({ file, line, source, snippet, reason: parsed.reason });
  };

  for (const block of blocks) {
    const lang = block.lang;
    const found: Array<{ source: ReferenceSource; offset: number; snippet: string; parsed: Parsed }> = [];
    if (HTTP_LANGS.has(lang)) {
      for (const r of httpInBlock(block, true)) found.push({ source: 'http', ...r });
    } else if (SHELL_LANGS.has(lang)) {
      const curls = curlInBlock(block);
      for (const r of curls) found.push({ source: 'curl', ...r });
      // An unlabelled block holding a bare request line is an HTTP example.
      if (curls.length === 0 && (lang === '' || lang === 'text' || lang === 'txt' || lang === 'plaintext')) {
        for (const r of httpInBlock(block, false)) found.push({ source: 'http', ...r });
      }
    } else if (JS_LANGS.has(lang)) {
      const js: Lang = { comment: '//', python: false };
      for (const r of callsInCode(block, js, /(?<![\w$.])fetch\s*\(/g, (_m, args) => parseFetchArgs(args))) {
        found.push({ source: 'fetch', ...r });
      }
    } else if (PY_LANGS.has(lang)) {
      const py: Lang = { comment: '#', python: true };
      const re = /(?<![\w.])(?:requests|httpx)\.(get|post|put|patch|delete|head|options|request)\s*\(/g;
      for (const r of callsInCode(block, py, re, (m, args) => parsePythonArgs(m[1]!, args))) {
        found.push({ source: 'python', ...r });
      }
    }
    for (const f of found) record(f.source, block.startLine + f.offset, f.snippet, f.parsed, block.suppressed);
  }

  for (const p of prose) {
    for (const r of proseReferences(p.text)) {
      const rq = queryOf(r.url);
      record('prose', p.line, r.snippet, { ok: true, ref: { method: r.method, url: r.url, query: rq.keys, ...(rq.unread ? { queryUnread: rq.unread } : {}), body: null } }, p.suppressed);
    }
  }

  result.references.sort((a, b) => a.line - b.line);
  result.unparsed.sort((a, b) => a.line - b.line);
  return result;
}
