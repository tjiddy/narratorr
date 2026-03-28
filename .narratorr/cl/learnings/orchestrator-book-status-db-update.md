---
scope: [scope/backend, scope/services]
files: [src/server/services/download-orchestrator.ts]
issue: 434
date: 2026-03-18
---
When extracting side effects from a service to an orchestrator, don't forget DB mutations that are "consequence" side effects (not core CRUD). The book status update (`books.status = 'downloading'`) was removed from DownloadService.grab() but initially not added to the orchestrator — only SSE emissions were added. The E2E test caught this because the search-grab flow expected book status to change. DB "shadow" updates that follow the primary operation must move with the other side effects.
