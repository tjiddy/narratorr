---
scope: [backend]
files: [src/server/jobs/index.ts, src/server/jobs/index.test.ts]
issue: 350
source: review
date: 2026-04-04
---
When widening a function signature (adding `bookService` to `runEnrichment`), the job registry wiring in `jobs/index.ts` must also be tested to verify the new argument is passed correctly. The coverage subagent flagged this as "untested indirectly" but didn't block — the reviewer caught it. Wiring files that call through to mocked functions need explicit argument assertions, not just "it compiles."
