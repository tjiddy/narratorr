---
scope: [scope/backend, scope/services]
files: [src/server/services/health-check.service.ts, src/server/services/health-check.service.test.ts]
issue: 147
source: review
date: 2026-03-27
---
The reviewer caught that checkLibraryRoot()'s new no-code fallback had no test. When fsAccess rejects a non-Error value, the new narrowing returns code=undefined and falls through to the "not writable" message. The existing tests only covered Error objects with real codes (ENOENT, EACCES).

Why we missed it: Same gap as F1/F3/F4/F5 — the implementation added the narrowing correctly but only considered the Error-with-code case when writing tests. The non-Error path was an implicit new behavior that got no coverage.

What would have prevented it: For every catch block that uses "instanceof Error && 'code' in error" narrowing, test the non-Error rejection path explicitly. The fallback path (code=undefined) produces a specific output that must be pinned.
