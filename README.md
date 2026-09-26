# APIBreak

Fails your CI build when a third-party API you actually call changes in a way
that can break you.

You list the vendor endpoints your code depends on. On every run the check
compares the vendor's own published OpenAPI specification at a baseline
revision against its current one, throws away everything you did not declare,
and reports what is left.

```
7 breaking, 1 deprecation, 9 advisory, 19 not compared — 10 endpoints checked, 210 additive changes not listed.
```

That line is from a real run against GitHub's and Stripe's published specs:
[`examples/example-report.md`](examples/example-report.md) is its full output,
and every finding names the two commits it compared.

## Why this exists

Vendors publish their specs. `oasdiff` already diffs two OpenAPI documents, and
it does it well. What neither gives you is the part that makes a diff
actionable. Between 2026-03-12 and 2026-09-16 GitHub's REST description added
154 operations, removed 8, and newly deprecated 7 — and the only question you
have is whether any of the 15 are endpoints your code calls. That filter, plus
a baseline you pin and a CI exit code, is what this is.

## Use it

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

Outputs: `breaking`, `deprecation`, `unknown`, `findings` (count) and
`report-json`. Each breaking finding is also emitted as a workflow error
annotation, and the full table lands in the job summary.

## Without a CI job

The same check runs from a terminal:

```
npx apibreak check --manifest apibreak.json
```

Or add it to a project with `npm i -D apibreak`. The package is one bundled
file, a README and a licence — **no dependencies**, **no install scripts** —
and it needs Node 20 or newer. It is early access at
[`apibreak@0.1.0`](https://www.npmjs.com/package/apibreak), two vendors, and
the interface may still change.

The Action wraps this same check and adds the annotations and job summary
above. Everything below — the manifest, what is detected, the exit codes —
is the same either way.

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

[`examples/apibreak.json`](examples/apibreak.json) is a working manifest.

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
finding. A removal is reported once, at its root: if `coupon` goes, the finding
names `coupon` and counts the nineteen fields that went with it.

A required field inside a *new optional* object is not reported. Nobody was
sending that object, so nothing broke.

Additive changes — new optional fields, new endpoints you did not declare — are
counted in the summary and never listed. They are not your problem.

## What it refuses to do

- **It does not read your code.** Nothing is scanned, no repository access
  beyond the checkout your workflow already has, no credentials, no traffic,
  nothing uploaded anywhere. The `github-token` input is optional and only
  raises the rate limit on the two public commit listings it reads. Every
  request has a 30 s stall deadline and a 5 minute ceiling, and a request that
  times out is reported as `unknown` rather than hanging the job.
- **It does not guess.** `anyOf`/`oneOf` is a genuine ambiguity — two schemas
  where a field is required in one branch and absent in the other cannot be
  compared without inventing an answer — so it is reported as `not compared`
  and never folded into a clean run. `allOf` is an unambiguous intersection and
  is merged, including intersecting two branches' enums; two branches that
  define the same field differently are the same ambiguity and get the same
  treatment.
- **It distinguishes "could not look" from "does not compare".** An endpoint
  whose document would not fetch or parse is `unknown` and fails your build,
  because a check that did not run is indistinguishable from a quiet week. A
  union deep in a schema is `not compared`: the check ran, this is a standing
  limit, it reads the same every week, and a permanently red build would just
  teach you to stop reading. Both appear in every report.
- **It does not compare what a vendor never enumerated.** A free-form
  `{"type": "object"}` has no fields to lose. If a vendor stops enumerating
  fields it used to list, that is one `not compared` row about the parent, not
  a pile of invented removals.
- **It does not claim completeness.** Only the endpoints in your `apibreak.json`
  are compared, and the summary says so on every run.
- **It does not tell you your integration is broken.** Across two pinned API
  versions a change is *upgrade impact*: it affects you when you move, not
  while you stay put. The report says which revisions it compared so you can
  tell the difference.
- **It does not fix anything** and it opens no pull requests.

## Supported vendors

| Vendor | Spec source | Versioning |
| --- | --- | --- |
| `github` | [github/rest-api-description](https://github.com/github/rest-api-description) | unversioned; changes land continuously |
| `stripe` | [stripe/openapi](https://github.com/stripe/openapi) | pinned API versions; changes are upgrade impact |

Twilio publishes an OpenAPI specification and is deliberately **not**
supported: `api_v2010` did not change a single operation over the six months
measured, so a monitor over it would have nothing honest to report.

Want another vendor? Open an issue with the public spec URL.

## Exit codes

`0` clean · `2` a finding at or above `fail-on`
(`breaking` | `deprecation` | `unknown` | `never`) · `1` the tool could not run
at all — a missing, unparseable or unusable manifest, or a bad argument.

A spec it fetched but could not read is **not** an exit-1 error: that is an
`unknown` finding and exits 2, because a check that dies quietly is
indistinguishable from a check that passed. `unknown` findings fail at every
threshold except `never`; `not compared` and `advisory` findings never fail.

## Status

Early access, and honestly labelled as such: the Action and the CLI — published
on npm as [`apibreak@0.1.0`](https://www.npmjs.com/package/apibreak) — are free
and always will be. A hosted version that emails you a weekly report without a
CI job is proposed at $49/org/month — [apibreak.dev](https://apibreak.dev) has
the worked example and the detail. No SLA, no real-time protection, and no
claim of complete coverage is offered anywhere.

`dist/index.js` is the committed bundle the Action runs. MIT licensed.
