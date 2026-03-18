---
scope: [scope/backend, scope/services]
files: [src/server/services/download.service.ts, src/shared/schemas/activity.ts]
issue: 434
source: spec-review
date: 2026-03-18
---
Spec used a `cancelled` download status that doesn't exist in downloadStatusSchema. Current cancel() writes `status: 'failed'` with `errorMessage: 'Cancelled by user'`. When fixing spec review findings, re-read the actual schema/enum definitions before introducing status literals — don't assume a status name from the method name.
