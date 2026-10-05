# apibreak

**Early access (0.3.2).** Two vendors, no SLA, and the interface may still
change. It is published so that people can try it and tell me where it is
wrong.

Fails your CI build when a third-party API you actually call changes in a way
that can break you.

Three ways to run it:

- **`apibreak check`** — you list the vendor endpoints your code depends on
  (github, stripe today). On every run the check compares the vendor's own
  published OpenAPI specification at a baseline revision against its current
  one, throws away everything you did not declare, and reports what is left.
- **`apibreak diff <old> <new>`** — compares any two OpenAPI 3.x or Swagger 2.0
  documents directly, local files or URLs, JSON or YAML. No manifest, no
  vendor registry — this works on your own specification too, which is what
  makes it usable as a PR check on your own repository (see `--base-ref`
  below).
- **`apibreak docs --spec openapi.yaml`** — reads the API calls in your own
  hand-written Markdown/MDX docs (curl, raw HTTP, `fetch()`, Python
  `requests`, inline `GET /v1/things/{id}`) and reports the ones your spec
  does not support.

```
7 breaking, 1 deprecation, 9 advisory, 19 not compared — 10 endpoints checked, 210 additive changes not listed.
```

## Install

```
npx apibreak check --manifest apibreak.json
```

Or add it to a project: `npm i -D apibreak`. It has **no dependencies** — the
package is one bundled file, a README and a licence — and **no install
scripts**. Node 20 or newer.

## What it does at runtime

`apibreak check` reads the manifest you point it at and fetches public vendor
specifications over HTTPS from `api.github.com` and
`raw.githubusercontent.com`. `apibreak diff` and `apibreak docs` fetch only
the spec URLs you pass them (a local path fetches nothing). That is the whole
of its network activity: it sends **no telemetry** and uploads **nothing** —
not your manifest, your specs, your docs or your results.

It needs **no vendor credentials** — no Stripe key, no repository access, no
traffic interception. There is one optional credential: a GitHub token that
raises the rate limit on commit lookups, read **only** from
`APIBREAK_GITHUB_TOKEN` and sent as a bearer token to `api.github.com`.
`GITHUB_TOKEN` and `RADAR_GITHUB_TOKEN` are no longer read (since 0.1.1); if
one is set, the CLI prints a warning saying so, because a token exported for
another tool's sake must not be picked up silently. The specifications
themselves are always downloaded unauthenticated. Set no token and the check
still runs, on GitHub's unauthenticated limit of 60 requests an hour.

Every request has a **30 s stall deadline** (the server sent nothing for 30 s)
and a **5 minute ceiling** on the request as a whole. A request that times out
becomes an `unknown` finding and fails the run unless you pass
`--fail-on never`; a slow but moving download is not cut off. Keep a job
timeout as belt and braces anyway — in GitHub Actions, `timeout-minutes: 10`.

## `apibreak.json`

```json
{
  "version": 1,
  "integrations": [
    {
      "vendor": "github",
      "baseline": "2026-03-16",
      "endpoints": [
        "GET /repos/{owner}/{repo}/actions/runs",
        "POST /repos/{owner}/{repo}/issues"
      ]
    },
    {
      "vendor": "stripe",
      "baseline": "2025-08-19",
      "endpoints": ["POST /v1/checkout/sessions"]
    }
  ]
}
```

`baseline` is a commit sha in the vendor's spec repository, or a `YYYY-MM-DD`
date that resolves to the last commit on or before it. Paths are the vendor's
own path templates, copied verbatim; a path that matches nothing in either spec
is an `unknown` finding, not a silent pass.

A vendor with an empty `endpoints` array is rejected. An empty vendor would
report a clean run for ever, which is the one failure mode this tool exists to
prevent.

## Supported vendors

| Vendor | Spec source | Versioning |
| --- | --- | --- |
| `github` | [github/rest-api-description](https://github.com/github/rest-api-description) | unversioned; changes land continuously |
| `stripe` | [stripe/openapi](https://github.com/stripe/openapi) | pinned API versions; changes are upgrade impact |

Twilio publishes an OpenAPI specification and is deliberately **not**
supported: `api_v2010` did not change a single operation over the six months
measured, so a monitor over it would have nothing honest to report.

## What it detects

| Finding | Severity |
| --- | --- |
| An operation you declared was removed | breaking |
| A request or response field was removed, at any depth | breaking |
| A request field became required, or arrived already required | breaking |
| The request body as a whole became required, or was withdrawn | breaking |
| A parameter became required, including an inherited path-level one | breaking |
| A field changed type | breaking |
| An enum value you may send was removed, with its replacement named | breaking |
| A field that accepted anything now accepts only a fixed set | breaking |
| A media type or a 2xx status the baseline offered is gone | breaking |
| An operation was newly marked deprecated | deprecation |
| A response enum gained a value your parser has never seen | advisory |
| An endpoint or a document the check could not read | **unknown** — fails the run |
| A part of a schema outside what the check compares | **not compared** — never fails |

Fields are compared at their full path, so `data.items[].id` disappearing is a
finding. A removal is reported once, at its root. A required field inside a
*new optional* object is not reported — nobody was sending that object.
Additive changes are counted in the summary and never listed.

## What it refuses to do

- **It does not read your code.** Nothing is scanned, no vendor credentials,
  no traffic interception.
- **It does not guess.** `anyOf`/`oneOf` is a genuine ambiguity and is reported
  as `not compared`, never folded into a clean run. The field a union sits on
  is still named, so a union field that disappears is a breaking removal.
  `allOf` is an unambiguous
  intersection and is merged.
- **It distinguishes "could not look" from "does not compare".** A document
  that would not fetch or parse is `unknown` and fails your build, because a
  check that did not run is indistinguishable from a quiet week.
- **It does not claim completeness.** Only the endpoints in your
  `apibreak.json` are compared, against only the two vendors above, and the
  summary says so on every run.
- **It does not tell you your integration is broken.** Across two pinned API
  versions a change is *upgrade impact*: it affects you when you move, not
  while you stay put. The report names the revisions it compared.
- **It does not fix anything** and it opens no pull requests.

## Usage

```
apibreak check [--manifest apibreak.json] [--fail-on breaking|deprecation|unknown|never]
               [--json out.json] [--summary out.md]
```

The Markdown report always goes to stdout. `--json` and `--summary`
additionally write it to files. Grouped `not compared` findings in the JSON
report also carry `paths`, the full sorted list of the fields not compared
(relative to `at`) — the detail line itself still names only three examples.

Exit codes: `0` clean, `2` a finding at or above `--fail-on`, `1` the tool
could not run at all — a missing, unparseable or unusable manifest, or a bad
argument. A spec it fetched but could not read is **not** an exit-1 error: that
is an `unknown` finding and exits 2. `unknown` findings fail at every threshold
except `never`; `not compared` and `advisory` findings never fail.

## `apibreak diff`

```
apibreak diff <old> <new> [--json] [--fail-on breaking|any|none]
apibreak diff --base-ref <git-ref> <path> [--json] [--fail-on breaking|any|none]
```

`<old>` and `<new>` are each a local file path or an http(s) URL, JSON or
YAML, OpenAPI 3.x or Swagger 2.0 — no manifest, no vendor registry, every
endpoint present in either document is compared. A Swagger 2.0 `body`
parameter is read as a request body; `formData` parameters are left as
ordinary parameters rather than guessed into one.

With `--base-ref <git-ref> <path>`, `<path>` is a file in your working tree,
compared against the same path read from `<git-ref>` with `git show` — run it
from inside the repository, so a pull request can check its own spec against
the branch it targets.

The Markdown report lists breaking changes first, then a count of everything
else; `--json` prints the full finding list plus counts. Fetches have a flat
20 s timeout.

Exit codes: `0` clean (or nothing at or above `--fail-on`), `1` a finding at or
above `--fail-on`, `2` a usage error or a document that could not be fetched
or parsed. `--fail-on breaking` (the default) fails only on a breaking
finding; `any` also fails on deprecations, unknowns and advisories, but never
on `not compared` — a standing limit of the comparison, not a change between
the two documents; `none` always exits 0.

In a GitHub Actions pull-request check:

```yaml
name: apibreak diff
on:
  pull_request:
    paths: [openapi.yaml]
jobs:
  diff:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
      - run: npx apibreak diff --base-ref origin/${{ github.base_ref }} openapi.yaml
```

`fetch-depth: 0` matters: a shallow checkout does not have the base branch's
history for `git show` to read.

## `apibreak docs`

```
apibreak docs --spec <file|url> [--base-url <url>]... [--json <path>] [--summary <path>]
              [--fail-on error|warning|never] [files or globs...]
```

Checks the API calls written in your hand-written docs against your own
OpenAPI 3.x or Swagger 2.0 spec. Files default to `docs/**/*.{md,mdx}` and
`README.md`. It reads fenced `curl` commands, raw HTTP request blocks,
JavaScript `fetch()` calls, Python `requests`/`httpx` calls, and inline
`METHOD /path` references in prose, then reports:

| Rule | Severity |
| --- | --- |
| `unknown-endpoint` — no spec path fits (the closest one is suggested) | error |
| `wrong-method` — the path exists, the method does not | error |
| `unknown-body-field` — a top-level body field the request schema does not list | error |
| `unknown-query-param` — a query parameter the operation does not declare | error |
| `missing-required` — a complete example that leaves out a required field or parameter | error |
| `deprecated-operation` / `deprecated-field` | warning |

Each finding carries `file:line`, the snippet and a fix hint. The server URLs
in the spec are stripped from documented URLs, `{id}`, `:id`, `<id>`,
`{{id}}` and concrete values like `cus_123` all fit a `{customer_id}`
template, and a URL on any other host is skipped and counted, not checked. If
your docs call `http://localhost:3000/api`, pass that as `--base-url`.

It errs towards silence: a body schema with `additionalProperties`, a `$ref`
it cannot resolve, a body read from a file or a variable, a query string with
a variable standing in for a whole parameter, or two path templates that fit
equally well each switch the dependent check off. Calls it cannot read (a URL
held in a variable, a computed method) are listed as unparsed rather than
guessed at. Silence one line or the next code block with
`<!-- apibreak-ignore -->` — the marker must be the whole comment, not just
mentioned inside one — a whole file with `<!-- apibreak-ignore-file -->`.

Run on the API docs of [listmonk](https://github.com/knadh/listmonk) (commit
`82db22c`, 2026-10-04) against its own `docs/swagger/collections.yaml`,
trimmed to three of the 14 rows:

```
**14 errors** — 10 files scanned, 129 API references found: 128 parsed (126 checked, 2 on other hosts), 1 unparsed.

| Severity | Where | Rule | Reference | Problem | Fix |
| **error** | `docs/docs/content/apis/bounces.md:30` | unknown-body-field | `GET http://localhost:9000/api/bounces?campaign_id=1&page=1&per_page=2` | GET /bounces declares no request body, but the example sends `order`, `order_by`, `source` | The spec has `order`, `order_by`, `source` as query parameters of GET /bounces; send them in the query string. |
| **error** | `docs/docs/content/apis/subscribers.md:610` | wrong-method | `POST http://localhost:9000/api/subscribers/query/blocklist` | /subscribers/query/blocklist has no POST operation | The spec allows PUT on `/subscribers/query/blocklist`. |
| **error** | `docs/docs/content/apis/lists.md:41` | unknown-query-param | `GET http://localhost:9000/api/lists?status=active&per_page=100` | query parameter "status" is not a parameter of GET /lists | Query parameters in the spec: `minimal`, `order`, `order_by`, `page`, `per_page`, `query`, `tag`. |
```

It only reports that the docs and the spec disagree; it cannot tell which one
is wrong. In that run, checked against listmonk's router, the first two rows
are mistakes in the docs: a GET body the server never reads, and POST where
the route is PUT. The third, and most of the other eleven, are the spec lagging
the server.

Exit codes: `0` nothing at or above `--fail-on` (default `error`), `1` a
finding at or above it, `2` a usage error, a spec that could not be read, or
no files to scan. `diff` uses the same convention; `check` predates it and
keeps its own (`2` a finding, `1` could not run), so a script that wraps both
should test each command's codes separately.

The GitHub Action's inputs are built around the `check` manifest, so run
`docs` as a plain step:

```yaml
name: apibreak docs
on:
  pull_request:
    paths: ['docs/**', 'README.md', 'openapi.yaml']
jobs:
  docs:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - run: npx apibreak docs --spec openapi.yaml --summary "$GITHUB_STEP_SUMMARY"
```

## In GitHub Actions

```yaml
name: apibreak
on:
  schedule: [{ cron: '0 13 * * 1' }]
  workflow_dispatch:
jobs:
  apibreak:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: Skyblueballykid/apibreak@v1
        with:
          manifest: apibreak.json
          fail-on: breaking
```

The Action wraps this same check and additionally emits workflow error
annotations and a job summary.

## Changelog

### 0.3.2 — 2026-10-05

Fewer false positives from `apibreak docs`, found by running it on 31 public
API docs repositories (876 raw findings before, 716 after; every finding that
disappeared was a misread example):

- A `<placeholder>` in a curl URL (`/invitations/<invitation_id>/revoke`) is
  read as a path value. Its `>` used to be taken for a redirect, which cut the
  URL short and dropped every option after it, `-X POST` included.
- A placeholder host (`https://<your-app>.fly.dev`, `<DEPLOYMENT_URL>`) is
  treated as this API only when the path fits the spec or starts with a server
  prefix; otherwise it is skipped and counted like any other host.
- A URL passed as a path segment (`/v2/publish/https://example.com`) stays one
  value instead of being collapsed and split.
- A curl command quoted in inline code ends at its closing backtick; a
  backtick command substitution is an unknown value, and a path built from one
  is not checked; PowerShell backtick escapes are read as escapes.

### 0.3.1 — 2026-10-05

- Bundles `yaml` 2.9.1, which fixes a stack overflow on deeply nested YAML
  collections (GHSA-48c2-rrv3-qjmp). A spec crafted that way could crash the
  CLI; nothing else changes.

### 0.3.0 — 2026-10-04

0.2.0 was prepared but never published; its changes ship here.

- **New:** `apibreak docs --spec <file|url> [files...]` — checks the API calls
  in hand-written Markdown/MDX docs against an OpenAPI 3.x or Swagger 2.0 spec
  (see above).
- **New:** `apibreak diff <old> <new>` — compares any two OpenAPI 3.x or
  Swagger 2.0 documents directly (local files or URLs, JSON or YAML), with no
  manifest and no vendor registry.
- **New:** `apibreak diff --base-ref <git-ref> <path>` — compares a spec file
  in the working tree against the same path at a git revision, for a
  pull-request check on your own repository.
- `diff`: when the root server path changes (`/v3` → `/api/v3`), path
  templates present in both documents are now paired and compared, and the
  change is reported once as `server_changed`. Before, every operation read
  as removed.
- `diff`: a success response described only as `default` (or `2XX`) on one
  side and as a single explicit code on the other is now paired, instead of
  reported as a removed status. When the other side lists several success
  codes, the pairing is not guessed; it is reported as `not compared`.
- YAML input is read with the [`yaml`](https://www.npmjs.com/package/yaml)
  package, bundled into the single file (the package still has zero
  dependencies). Anchors and aliases (and with them `<<` merges), duplicate keys and
  multi-document files are refused rather than resolved.

### 0.1.3 — 2026-10-02

- An OpenAPI 3.1 path item written as a `$ref` (to `components/pathItems`) is
  now followed. Before, every operation under it read as removed, a false
  breaking finding. A path-item `$ref` that points outside the document, does
  not resolve, or sits next to its own operations makes that specification
  unreadable, so every declared endpoint is reported `unknown`, never removed.
- A schema `$ref` that shares its node with structural keywords (`properties`,
  `type`, `required`, …) is now listed as not compared rather than followed
  with those keywords dropped.

### 0.1.2 — 2026-09-26

- Every path that was not compared is named in the report and the JSON
  (`paths[]`), not only a count; a field removed from inside a union is
  reported.

### 0.1.1 — 2026-09-26

- **Breaking:** the CLI no longer reads `GITHUB_TOKEN` or `RADAR_GITHUB_TOKEN`.
  The one optional credential is read only from `APIBREAK_GITHUB_TOKEN`; if one
  of the old variables is set, the CLI prints a warning saying so.
- Every request now has a 30 s stall deadline and a 5 minute total ceiling. A
  request that times out becomes an `unknown` finding (which fails the run
  unless `--fail-on never`) instead of hanging the job; a slow but progressing
  download is not cut off.

### 0.1.0 — 2026-09-22

First release.

## Licence

MIT. <https://apibreak.dev> · <https://github.com/Skyblueballykid/apibreak>
