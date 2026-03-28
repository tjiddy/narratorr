---
scope: [backend, services]
files: [src/server/services/download.service.ts, src/server/services/download.service.test.ts]
issue: 63
source: review
date: 2026-03-24
---
When scoping a new feature query to a subset of statuses, verify that other statuses which were previously covered by the original query don't lose their behavior. Replacing `getInProgressStatuses()` with `getReplacableStatuses()` silently removed the duplicate-check protection for `processing_queued` and `importing`. The fix: fetch all active downloads with `getActiveByBookId()` (one query) and split in-memory into replaceable vs pipeline — avoids two queries and makes the boundary explicit.
