---
scope: [frontend]
files: [src/client/pages/manual-import/pathUtils.ts, src/client/pages/manual-import/ManualImportPage.test.tsx]
issue: 134
date: 2026-03-26
---
When blocking paths "inside" a library root, the exact-equal case (scanPath === libraryPath) also needs to be blocked — scanning the library root itself would rediscover already-managed books. A "strictly inside" check using `scanSegments.length > rootSegments.length` misses this; use `>=` instead. The spec test plan explicitly listed "scan path exactly equal to library root → warning shown" but the naive "inside" implementation returns false for equal paths.
