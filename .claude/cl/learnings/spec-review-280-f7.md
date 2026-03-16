---
scope: [scope/backend, scope/frontend]
files: [src/server/routes/system.ts]
issue: 280
source: spec-review
date: 2026-03-10
---
AC stated "Backup failure surfaces as health warning" while scope boundaries said "Health dashboard integration is out of scope (covered by #279)." Direct contradiction. The elaboration step added the scope boundary correctly but didn't catch the conflicting AC it had inherited from the original spec. Always cross-check AC items against scope boundaries for contradictions, especially when deferring related functionality to other issues.
