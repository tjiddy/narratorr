---
scope: [scope/backend, scope/services]
files: [src/server/services/download.service.ts]
issue: 434
date: 2026-03-18
---
After stripping side effects from DownloadService.grab(), the method was still at complexity 22 (ESLint max 15). The fix was extracting `parseDownloadInput()` and `sendToClient()` private helpers. Protocol-specific parsing (data URI detection, info hash extraction) and client wiring (getFirstEnabled, getAdapter, category extraction) are natural extraction points that each reduce 3-5 branches from the main method.
