---
scope: [backend]
files: [src/server/jobs/search.test.ts, src/server/routes/books.test.ts, src/server/jobs/rss.test.ts, src/server/services/retry-search.test.ts]
issue: 439
source: review
date: 2026-04-09
---
When threading a new parameter through multiple callers (7 auto-grab paths), tests must assert behavioral outcomes (which candidate gets grabbed) — not just that settings.get() was called. The handoff coverage review flagged invocation-only assertions, but the initial fix was still too shallow. Effective caller-matrix tests need two candidates in the same match-score band with opposing narrator/quality rankings, then assert the correct one is grabbed under each priority mode.