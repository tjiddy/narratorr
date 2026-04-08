---
scope: [frontend]
files: [src/client/pages/library-import/useLibraryImport.test.ts]
issue: 415
date: 2026-04-08
---
When appending test blocks to the end of a test file, verify which `describe` block they land inside. In `useLibraryImport.test.ts`, the file has multiple top-level describe blocks with different `beforeEach` setups. Appending tests inside `describe('empty result edge case')` (which has no mock setup) caused 5-second timeouts because settings/scan/match mocks weren't initialized. The fix was moving the tests into `describe('handleEdit — auto-check, confidence upgrade')` which has the correct `beforeEach`.
