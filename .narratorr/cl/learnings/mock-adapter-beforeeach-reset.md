---
scope: [backend, services]
files: [src/server/services/quality-gate.service.test.ts]
issue: 350
date: 2026-03-14
---
When changing a shared mock adapter's return shape (e.g., adding `name` to DownloadItemInfo), check for `beforeEach` blocks that reset the mock — they override the initial declaration. The QG test file had `beforeEach` resetting `mockAdapter.getDownload` to the old shape without `name`, causing 14 test failures until both the initial value AND the `beforeEach` reset were updated.
