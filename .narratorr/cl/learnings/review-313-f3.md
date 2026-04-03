---
scope: [backend]
files: [src/server/services/backup.service.ts, src/server/routes/system.ts]
issue: 313
source: review
date: 2026-04-03
---
When a method has multiple error code branches (MISSING_DB, INVALID_DB, INVALID_ZIP), every branch needs a test — not just the ones that seemed "interesting." The INVALID_ZIP branch for corrupt files was treated as covered by the upload tests, but the new restoreServerBackup method has its own try/catch with the same INVALID_ZIP mapping, and that path needs its own assertion.
