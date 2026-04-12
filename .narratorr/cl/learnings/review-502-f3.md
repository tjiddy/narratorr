---
scope: [backend]
files: [src/server/services/search-pipeline.test.ts, src/server/jobs/rss.test.ts]
issue: 502
source: review
date: 2026-04-12
---
Integration tests that only assert `expect(mock).toHaveBeenCalledWith(...)` prove the call happened but not that the enriched data affects the outcome. If enrichment ran *after* filtering, these tests would still pass. The minimum assertion contract for enrichment-before-filtering tests: configure the mock to set a value that changes the ranking/filtering decision, then assert the observable consequence (grab suppressed, different result selected). "Was called" is a necessary but not sufficient assertion for ordering-dependent behavior.
