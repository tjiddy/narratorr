---
scope: [scope/backend, scope/core]
files: [src/core/download-clients/sabnzbd.test.ts, src/core/download-clients/sabnzbd.ts]
issue: 662
source: review
date: 2026-04-21
---
Same root cause as F1 but in `getAllDownloads()`. The nearby test at
`sabnzbd.test.ts:479-499` captured request URLs and asserted `cat`, but never
asserted `limit`. Because the tests were "close enough" to look like coverage,
it was easy to assume the behavior was guarded. It wasn't.

Why we missed it: when a test captures URLs and asserts SOME parameter, it
feels like the full contract is covered. It isn't — each parameter needs its
own explicit assertion. Partial parameter coverage is the sibling pattern of
"called vs. calledWith".

Prevention: When writing or reviewing a URL-capture test, enumerate every
parameter the production code sets on that request and add an explicit
assertion for each one (or a single `expect(Object.fromEntries(params))`
snapshot). If a parameter is added to production code but not asserted in
tests, reviewers should flag it — and authors should notice before handoff.
