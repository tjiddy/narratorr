---
scope: [scope/backend, scope/frontend]
files: [src/db/schema.ts, src/shared/download-status-registry.ts]
issue: 283
source: spec-review
date: 2026-03-10
---
Spec used a single `status_change` event for both book and download status transitions, but these are completely different enums (BookStatus: wanted/searching/downloading/importing/imported/missing/failed vs DownloadStatus: queued/downloading/paused/completed/checking/pending_review/processing_queued/importing/imported/failed). The generic name made it ambiguous which entity changed. Prevention: when a spec involves status transitions, check the schema for the actual enum types and split events by entity type when they differ.
