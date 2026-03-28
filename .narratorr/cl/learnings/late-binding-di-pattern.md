---
scope: [backend]
files: [src/server/routes/index.ts, src/server/services/download.service.ts, src/server/services/event-history.service.ts]
issue: 270
date: 2026-03-08
---
When services have circular dependencies (e.g., DownloadService needs RetrySearchDeps which includes DownloadService), use a `setXDeps()` method called after all services are constructed in `createServices()`. This avoids constructor circular refs while keeping DI explicit and testable.
