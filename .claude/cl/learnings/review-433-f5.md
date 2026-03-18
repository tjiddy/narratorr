---
scope: [scope/core]
files: [src/core/metadata/audnexus.test.ts]
issue: 433
source: review
date: 2026-03-17
---
Reviewer caught that Audnexus getAuthor() had 5xx and 404 tests but was missing timeout and network error tests — same gap as F4 but on a different provider. Same root cause: assumed shared fetch helper coverage was sufficient. Prevention: same as F4 — enumerate all error categories for every changed entry point.
