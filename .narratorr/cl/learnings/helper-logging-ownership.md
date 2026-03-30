---
scope: [backend]
files: [src/server/utils/import-steps.ts, src/server/utils/import-helpers.ts, src/server/services/import.service.ts]
issue: 229
date: 2026-03-30
---
Utility functions in `src/server/utils/` don't accept logger parameters by design (they're pure/throwable). When specs call for debug logging around utility calls, the logging must happen at the caller site, not inside the utility. For `checkDiskSpace`, the cleanest approach was changing the return type to expose computed values, rather than adding a logger parameter. This pattern should be followed for future utility telemetry needs.
