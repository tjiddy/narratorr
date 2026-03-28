---
scope: [scope/backend, scope/core]
files: [src/server/jobs/enrichment.ts, src/server/jobs/backup.ts, src/server/jobs/rss.ts]
issue: 431
source: spec-review
date: 2026-03-17
---
Reviewer caught stale magic number inventory: 60*60*1000 only appears as a fixed constant in enrichment.ts, not backup/rss (which are dynamic from user settings). Prevention: grep for the actual pattern and read context around each match to distinguish fixed constants from dynamic calculations.
