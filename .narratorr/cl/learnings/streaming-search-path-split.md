---
scope: [backend]
files: [src/server/services/search-pipeline.ts]
issue: 392
date: 2026-04-07
---
`searchAndGrabForBook()` now has two paths: broadcaster path (uses `searchAllStreaming` with per-indexer callbacks) and legacy path (uses `searchAll`). When adding broadcaster to a caller, ALL tests that previously mocked `searchAll` must switch to mocking `searchAllStreaming` + `getEnabledIndexers`, because the broadcaster's presence determines which path runs. Tests that assert `searchAll` was called will silently pass if the broadcaster is falsy, masking the intended behavior change.
