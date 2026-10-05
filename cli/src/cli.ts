#!/usr/bin/env node
/**
 * `apibreak check` — the whole product, from a customer's point of view.
 *
 * It reads one file they wrote, fetches two public specifications, prints what
 * changed in the endpoints they declared, and exits non-zero if any of it is
 * breaking. No vendor credentials, no repository access, nothing uploaded —
 * and the one optional credential, a GitHub token that only raises the rate
 * limit on commit lookups, is read from `APIBREAK_GITHUB_TOKEN` and nothing
 * else. That is both a design principle and the reason it can be installed
 * without a procurement conversation.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { DIFF_USAGE, runDiff } from './diff-cli.js';
import { DOCS_USAGE, runDocs } from './docs-cli.js';
import { parseManifest } from './manifest.js';
import { exitCode, renderJson, renderMarkdown } from './report.js';
import { runRadar } from './run.js';

type FailOn = 'breaking' | 'deprecation' | 'unknown' | 'never';

const FAIL_ON: readonly FailOn[] = ['breaking', 'deprecation', 'unknown', 'never'];

interface Options {
  manifestPath: string;
  failOn: FailOn;
  jsonOut?: string;
  summaryOut?: string;
}

function parseArgs(argv: string[]): Options | { error: string } {
  const opts: Options = { manifestPath: 'apibreak.json', failOn: 'breaking' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string | undefined => argv[++i];
    switch (arg) {
      case '--manifest': {
        const v = next();
        if (!v) return { error: '--manifest needs a path' };
        opts.manifestPath = v;
        break;
      }
      case '--fail-on': {
        const v = next();
        if (!v || !FAIL_ON.includes(v as FailOn)) {
          return { error: `--fail-on must be one of ${FAIL_ON.join(', ')}` };
        }
        opts.failOn = v as FailOn;
        break;
      }
      case '--json': {
        const v = next();
        if (!v) return { error: '--json needs a path' };
        opts.jsonOut = v;
        break;
      }
      case '--summary': {
        const v = next();
        if (!v) return { error: '--summary needs a path' };
        opts.summaryOut = v;
        break;
      }
      default:
        return { error: `unknown argument "${arg}"` };
    }
  }
  return opts;
}

const USAGE = `apibreak check [--manifest apibreak.json] [--fail-on breaking|deprecation|unknown|never]
                [--json out.json] [--summary out.md]

Compares the vendor API specifications you depend on against the baseline you
pinned, and reports only the changes that touch the endpoints in your manifest.
Set APIBREAK_GITHUB_TOKEN to raise GitHub's rate limit on commit lookups; no
other variable is read.
Exits 2 when a finding meets the --fail-on threshold, 1 on a usage or input
error, 0 otherwise.

apibreak diff <old> <new> [--json] [--fail-on breaking|any|none]
apibreak diff --base-ref <git-ref> <path> [--json] [--fail-on breaking|any|none]

Compares any two OpenAPI/Swagger documents directly — no manifest, no vendor
registry. Run "apibreak diff --help" for its own usage.

apibreak docs --spec <file|url> [--base-url <url>]... [--json out.json] [--summary out.md]
              [--fail-on error|warning|never] [files or globs...]

Checks the curl/HTTP/fetch/requests examples and inline "GET /path" references
in your hand-written Markdown docs against your OpenAPI spec. Run
"apibreak docs --help" for its own usage.`;

/**
 * Which environment variable is the token allowed to come from? Only our own
 * name. A `GITHUB_TOKEN` exported for some other tool's sake must not be sent
 * silently to api.github.com by this one, and a user who set one of those
 * other names deserves to be told why their rate limit did not rise — the
 * warning names the variables actually set and never repeats their values.
 */
export function githubTokenFrom(env: NodeJS.ProcessEnv): { token?: string; warning?: string } {
  const token = env.APIBREAK_GITHUB_TOKEN?.trim();
  if (token) return { token };
  const names = ['GITHUB_TOKEN', 'RADAR_GITHUB_TOKEN'].filter((name) => env[name]?.trim());
  if (names.length === 0) return {};
  return {
    warning: `${names.join(' and ')} ${names.length === 1 ? 'is' : 'are'} set but not used; apibreak only reads APIBREAK_GITHUB_TOKEN (since 0.1.1). Without a token GitHub allows 60 unauthenticated requests an hour.`,
  };
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(`${USAGE}\n`);
    return command ? 0 : 1;
  }
  if (command === 'diff') {
    if (rest[0] === '--help' || rest[0] === 'help') {
      process.stdout.write(`${DIFF_USAGE}\n`);
      return 0;
    }
    return runDiff(
      rest,
      { fetch, now: () => new Date(), cwd: process.cwd() },
      { write: (s) => process.stdout.write(s) },
      { write: (s) => process.stderr.write(s) }
    );
  }

  if (command === 'docs') {
    if (rest[0] === '--help' || rest[0] === 'help') {
      process.stdout.write(`${DOCS_USAGE}\n`);
      return 0;
    }
    return runDocs(
      rest,
      { fetch, now: () => new Date(), cwd: process.cwd() },
      { write: (s) => process.stdout.write(s) },
      { write: (s) => process.stderr.write(s) }
    );
  }

  if (command !== 'check') {
    process.stderr.write(`unknown command "${command}"\n\n${USAGE}\n`);
    return 1;
  }

  const opts = parseArgs(rest);
  if ('error' in opts) {
    process.stderr.write(`${opts.error}\n\n${USAGE}\n`);
    return 1;
  }

  let source: string;
  try {
    source = await readFile(opts.manifestPath, 'utf8');
  } catch {
    process.stderr.write(`cannot read ${opts.manifestPath}\n`);
    return 1;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(source);
  } catch (e) {
    process.stderr.write(`${opts.manifestPath} is not valid JSON: ${(e as Error).message}\n`);
    return 1;
  }

  const parsed = parseManifest(parsedJson);
  if (!parsed.ok) {
    process.stderr.write(`${opts.manifestPath} is not usable:\n${parsed.errors.map((e) => `  - ${e}`).join('\n')}\n`);
    return 1;
  }
  for (const warning of parsed.warnings) process.stderr.write(`warning: ${warning}\n`);

  // Nothing is picked up unless the user used our own name; see
  // githubTokenFrom for why the legacy variables are refused rather than used.
  const { token, warning } = githubTokenFrom(process.env);
  if (warning) process.stderr.write(`warning: ${warning}\n`);

  const report = await runRadar(parsed.manifest, {
    fetch,
    now: () => new Date(),
    githubToken: token,
  });

  const markdown = renderMarkdown(report);
  process.stdout.write(`${markdown}\n`);
  if (opts.jsonOut) await writeFile(opts.jsonOut, renderJson(report), 'utf8');
  if (opts.summaryOut) await writeFile(opts.summaryOut, markdown, 'utf8');

  return exitCode(report, opts.failOn);
}
