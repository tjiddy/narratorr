---
scope: [scope/backend, scope/frontend]
files: [src/client/lib/api/activity.ts, src/server/services/download.service.ts]
issue: 283
source: spec-review
date: 2026-03-10
---
SSE event payloads used `book_id` as the primary key for download-scoped events, but the activity feed is keyed by download rows (`Download.id`), not books. A single book can have multiple download rows over time. The spec should have checked how the frontend identifies activity items before designing event payloads. Prevention: always check the frontend data model (query keys, list item identifiers) before specifying event/notification payloads.
