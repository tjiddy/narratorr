---
scope: [backend]
files: [src/server/services/refresh-scan.service.ts]
issue: 444
source: review
date: 2026-04-09
---
Bare `catch` blocks around filesystem operations (like `stat()`) silently reclassify permission errors and I/O failures as "path not found" (400), hiding real server faults from operators. Always narrow the catch to the specific error code (`ENOENT` for missing paths) and rethrow everything else. The existing `tagging.service.ts` has the same pattern — this is a codebase-wide gap, not just this feature.
