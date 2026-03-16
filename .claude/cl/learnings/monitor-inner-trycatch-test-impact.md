---
scope: [backend]
files: [src/server/jobs/monitor.ts, src/server/jobs/monitor.test.ts]
issue: 271
date: 2026-03-09
---
Adding inner try/catch blocks in the monitor loop (e.g., catching adapter.getDownload() throws separately from the outer loop) changes error logging messages and call counts. Existing tests that assert specific log messages like `'Error monitoring download'` may break because the inner catch now logs a different message like `'Adapter error fetching download'`. Also, `db.update` call counts change since the inner catch may trigger its own status update to 'failed'.
