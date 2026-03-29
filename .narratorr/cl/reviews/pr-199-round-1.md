---
skill: respond-to-pr-review
issue: 199
pr: 208
round: 1
date: 2026-03-29
fixed_findings: [F1, F2, F3, F4, F5, F6]
---

### F1/F2/F4: Network-error tests used non-deterministic assertions
**What was caught:** Tests used `HttpResponse.error()` and asserted `.not.toBe()` instead of exact message match.
**Why I missed it:** Defaulted to MSW's network error simulation without considering that the error message from `HttpResponse.error()` is implementation-dependent and the negative assertions wouldn't catch regressions.
**Prompt fix:** Add to `/implement` step 4a: "When testing error-message propagation contracts (`error.message` returned to caller), always use deterministic mock values and assert the exact string — negative assertions (`.not.toBe()`, `.toBeDefined()`) are vacuous for message contracts."

### F3: Response text not asserted in error response tests
**What was caught:** Non-2xx response tests only asserted status code, not the response body text that adapters include in the message.
**Why I missed it:** Treated existing test assertions as sufficient without checking whether they tested the full format contract (`HTTP <status>: <body>`).
**Prompt fix:** Add to `/implement` step 4a: "When testing formatted error messages (e.g., `HTTP <status>: <body>`), assert every component of the format string — status code AND body text."

### F5/F6: Missing zero-value tests for download.size and import.fileCount
**What was caught:** The spec explicitly listed zero-value tests for download.size=0 and import.fileCount=0, but only release.size=0 was implemented.
**Why I missed it:** The spec listed three zero-value test cases but I only implemented one, treating the release.size=0 test as covering the pattern. Each `!= null` guard is a separate branch requiring its own test.
**Prompt fix:** Add to `/implement` step 4d: "When the spec lists N test cases for a pattern, verify all N are implemented — not just one representative case. Each branch guard is independently testable."
