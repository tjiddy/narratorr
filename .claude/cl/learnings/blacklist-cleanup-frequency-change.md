---
scope: [backend]
files: [src/server/jobs/housekeeping.ts, src/server/jobs/blacklist-cleanup.ts]
issue: 332
date: 2026-03-10
---
Consolidating the standalone blacklist-cleanup job into housekeeping changed its frequency from daily to weekly. This is acceptable because expired entries are already filtered at query time (`getBlacklistedHashes` uses `gt(expiresAt, now)`), so they're functionally ignored even before cleanup runs. The cleanup just reclaims storage. Worth noting when consolidating jobs: check whether the original schedule matters for correctness vs just cleanup.
