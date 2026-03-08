---
scope: [scope/backend]
files: [src/server/services/download.service.ts, src/server/services/download.service.test.ts]
issue: 270
source: review
date: 2026-03-08
---
Reviewer caught that DownloadService.retry() had tests only for throw paths (not found, wrong state, no book, no deps) but no tests for the happy path branches (retried/no_candidates/retry_error). Each branch has distinct DB side effects (delete old record, update errorMessage) that weren't validated. Gap was a test planning gap — when adding a method with multiple outcome branches, every branch needs its own test asserting the specific DB mutations and return values.
