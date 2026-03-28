---
scope: [scope/backend, scope/db]
files: []
issue: 408
source: spec-review
date: 2026-03-17
---
The concurrency note for expiry said to use `WHERE status = 'pending'` on the initial query, but the reviewer pointed out this doesn't protect against status changes between the read and delete — the DELETE itself needs the predicate. The existing stale-removal pattern in `discovery.service.ts:97-115` already shows this exact anti-pattern (read IDs, then delete by ID only). Root cause: the concurrency requirement was stated as a query-level concern when it's actually a delete-level safety property. Would have been caught by framing concurrency requirements as "the operation that mutates must be atomic with respect to X" rather than "the read should filter by X".