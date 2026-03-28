---
scope: [backend, frontend, core]
files: [src/core/indexers/types.ts, src/server/services/indexer.service.ts, src/client/lib/api/search.ts, src/client/components/SearchReleasesModal.tsx]
issue: 57
source: review
date: 2026-03-23
---
When adding a new data field to the activity display, trace the full origin path of that data — not just the read path. The indexerName feature correctly joined indexers in the activity read queries, but the write path (search → grab → download row) was not traced. searchAll() returned results with indexer: string but no indexerId, and SearchReleasesModal.handleGrab() didn't forward indexerId even though the grab API already accepted it. The fix required: (1) adding indexerId to core SearchResult type, (2) populating it in searchAll() from the indexer DB row, (3) adding indexerId to the client SearchResult interface, (4) forwarding it in handleGrab(). Spec gap: the issue spec only described the read side (join in DownloadService); the write side (FK population at download creation) was not included in AC or test plan.
