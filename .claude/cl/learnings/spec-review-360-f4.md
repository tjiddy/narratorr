---
scope: [scope/backend, scope/services]
files: [src/server/services/import-list.service.ts, src/server/routes/prowlarr.ts, src/server/routes/settings.ts]
issue: 360
source: spec-review
date: 2026-03-14
---
AC1 missed sentinel passthrough in `import-list.service.ts:51-64` and `routes/prowlarr.ts:56-58`. The debt scan only mentioned 3 services but the codebase has the same pattern in at least 5 places. Root cause: trusted the debt scan finding without grepping `isSentinel` across the full codebase. For dedup specs, always grep for the target pattern before writing the AC to find all instances.
