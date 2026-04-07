---
scope: [backend, services]
files: [src/server/utils/import-helpers.ts, src/server/utils/import-helpers.test.ts]
issue: 397
date: 2026-04-07
---
Existing tests used `Disc 1` / `Disc 2` as generic subfolder names for non-disc-related test cases (collision detection, basic flattening). After adding real disc detection, these tests broke because the folder names now trigger the multi-disc path. Had to rename test folders to `Part 1` / `Part 2`. When adding pattern-based detection, check existing tests for folder names that accidentally match the new pattern.
