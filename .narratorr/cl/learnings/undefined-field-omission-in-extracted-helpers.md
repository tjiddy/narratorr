---
scope: [backend]
files: [src/server/services/grab-payload.ts]
issue: 405
date: 2026-04-07
---
When extracting a shared helper that conditionally omits undefined fields (e.g., `if (x !== undefined) payload.x = x`), existing tests that assert `expect.objectContaining({ field: undefined })` will fail — the field is now absent, not explicitly undefined. Update test assertions to use `expect(obj).not.toHaveProperty('field')` instead. This affected 3 test files (retry-search, search-pipeline, rss).
