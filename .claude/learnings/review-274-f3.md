---
scope: [backend]
files: [src/server/services/download.service.test.ts, src/server/services/import.service.test.ts, src/server/services/rename.service.test.ts]
issue: 274
source: review
date: 2026-03-06
---
Reviewer flagged missing integration tests for lifecycle event producers. When adding fire-and-forget side effects (like event recording) to existing service methods, the existing unit tests won't cover the new behavior — dedicated tests that verify the side effect was called with correct args are needed. Pattern: inject a mock EventHistoryService as optional constructor param, then assert `.create()` was called with expected eventType/source/bookId after the lifecycle action completes.
