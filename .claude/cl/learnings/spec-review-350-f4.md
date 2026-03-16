---
scope: [scope/backend, scope/services]
files: [src/server/services/download.service.ts]
issue: 350
source: spec-review
date: 2026-03-14
---
Spec review caught that the M-9 AC/test plan referred to `cancelDownload` but the actual `DownloadService` method is `cancel(id: number)` at download.service.ts:375. When /respond-to-spec-review added the 5th call site per F3, it used the wrong method name without reading the actual source to verify. Always verify the exact method signature when adding new call site references to a spec.
