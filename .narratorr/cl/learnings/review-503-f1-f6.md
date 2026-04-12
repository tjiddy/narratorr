---
scope: [backend, frontend]
files: [src/server/services/settings.service.test.ts, src/server/routes/settings.test.ts, src/server/services/search-pipeline.test.ts, src/server/services/retry-search.test.ts, src/server/jobs/search.test.ts, src/server/jobs/rss.test.ts]
issue: 503
source: review
date: 2026-04-12
---
Reviewer caught missing caller-level tests for maxDownloadSize pass-through and debug logging at all 6 filterAndRankResults call sites, plus missing backend persistence tests (service merge + route round-trip). The spec's test plan explicitly required backend persistence tests, but implementation only covered helper-level filter tests and UI form tests. When a spec calls for "test every layer," each caller wrapper that adds behavior (param forwarding + debug logging) needs its own assertion — helper-level coverage alone is insufficient. The fix was mechanical: follow existing patterns (e.g., minSeeders test in search.test.ts) and add one test per caller.
