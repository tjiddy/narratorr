---
scope: [backend]
files: [src/server/jobs/enrichment.ts, src/server/jobs/enrichment.test.ts]
issue: 482
source: review
date: 2026-04-12
---
When refactoring error handling in batch processing, always add a test that triggers the new failure path and proves the batch continues. A counter assertion alone (like `filledNarrators: 1`) is vacuous if it passes regardless of whether the catch block exists. The test must: (1) make one item throw, (2) make a subsequent item succeed, (3) assert the subsequent item's side effects, and (4) assert the batch completion log.
