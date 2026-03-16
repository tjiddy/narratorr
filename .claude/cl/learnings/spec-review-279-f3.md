---
scope: [scope/db, scope/backend]
files: [src/db/schema.ts, src/server/jobs/monitor.ts, src/server/services/download.service.ts]
issue: 279
source: spec-review
date: 2026-03-10
---
Spec proposed "stuck download" detection (>1hr no progress) without checking if the schema supports it. Downloads table has no `progressUpdatedAt` timestamp — only `progress` (real), `addedAt`, and `completedAt`. When a feature depends on temporal data, always verify the schema has the required timestamp columns before writing the spec.
