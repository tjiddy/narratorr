---
scope: [backend]
files: [src/server/services/library-scan.service.ts]
issue: 342
date: 2026-04-04
---
Within-scan dedup maps must be function-local (not instance-level) to avoid cross-scan state leakage. The `withinScanSlugMap` is created inside `scanDirectory()` and discarded after each call. Moving it to a class field would break concurrent scan isolation. This was also confirmed with an explicit test case.
