---
scope: [scope/frontend, scope/api]
files: [src/client/lib/api/backups.ts]
issue: 280
source: review
date: 2026-03-10
---
The backupsApi helpers (multipart upload for restore, URL-encoded filename for download) had no unit tests. Prevention: API client helpers with non-trivial request construction (multipart, URL encoding) need dedicated tests to catch serialization bugs early.
