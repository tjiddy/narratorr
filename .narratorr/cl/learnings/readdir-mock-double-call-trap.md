---
scope: [backend, services]
files: [src/server/utils/import-helpers.ts, src/server/utils/import-helpers.test.ts]
issue: 397
date: 2026-04-07
---
When adding a pre-scan step before an existing recursive function (e.g., reading root entries to detect disc folders before calling `collectAudioFiles`), the mocked `readdir` gets called an extra time. If the original function also reads the root directory, mocks queue up wrong. Solution: reuse the root entries from the pre-scan instead of calling the recursive function on the root again. This avoids double-readdir and keeps existing test mocks working.
