---
scope: [backend]
files: [src/server/routes/library-scan.ts, src/server/services/library-scan.service.ts]
issue: 454
date: 2026-04-09
---
The scan-debug endpoint builds its own search trace via `runSearchTrace()` in the route file — it does NOT call `lookupMetadata()` from the service. Any new search behavior (like direct ASIN lookup) must be implemented in BOTH places: the service method for production use AND the route helper for debug traces.
