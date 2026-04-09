---
scope: [backend]
files: [src/server/routes/search-stream-filtering.test.ts]
issue: 438
date: 2026-04-09
---
For test-only issues where production code already exists, the red/green TDD cycle doesn't apply — tests are expected to pass immediately since the behavior is already implemented. The value is proving coverage exists, not driving implementation. Don't force artificial failures just to satisfy the "red" phase convention.
