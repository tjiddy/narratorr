---
scope: [backend]
files: [src/server/services/import-list.service.test.ts]
issue: 285
source: review
date: 2026-03-11
---
Service tests for the sync loop only asserted that providers were called, not that the persistence layer received correct payloads (lastRunAt, nextRunAt, lastSyncError, importListId, book_events source). When testing a multi-step process, assert the observable outputs of each step — not just the entry point. The chainable mock DB pattern requires careful attention to `.where()` returning chain vs array when `.limit()` follows.
