---
scope: [scope/backend]
files: [src/server/jobs/index.ts, src/server/jobs/search.ts, src/server/jobs/rss.ts, src/server/jobs/backup.ts]
issue: 279
source: spec-review
date: 2026-03-10
---
Spec referenced an "existing cron job registry" that doesn't exist. Jobs use two different scheduling mechanisms (cron.schedule vs setTimeout loops) with no shared metadata layer. Technical notes must be verified against the actual codebase — don't assume infrastructure exists just because it seems like it should.
