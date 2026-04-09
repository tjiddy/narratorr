---
scope: [backend]
files: [src/server/services/book.service.test.ts]
issue: 437
source: review
date: 2026-04-09
---
When adding conditional logic to both a primary path and a retry/fallback path, negative tests must cover BOTH paths independently. The primary-path negative tests (first-write-wins, no-op on undefined) don't automatically prove the retry path has the same guards. Each code path with an `if` guard needs its own positive and negative test.
