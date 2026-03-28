---
scope: [scope/core]
files: [src/core/metadata/audible.test.ts]
issue: 433
source: review
date: 2026-03-17
---
Reviewer caught that Audible getBook() had 5xx and 404 tests but was missing timeout and network error tests, even though searchBooks() had all four variants covered. The assumption was that the shared request helper would propagate correctly, but each entry point deserves its own direct coverage to guard against regressions. Prevention: when adding error classification tests, enumerate all error categories (timeout, network, 5xx, 404) for every changed entry point — not just the first one tested. Use the searchBooks test list as the template.
