---
scope: [scope/backend, scope/services]
files: [src/server/services/health-check.service.ts, src/server/services/health-check.service.test.ts]
issue: 147
source: review
date: 2026-03-27
---
checkStuckDownloads()'s new non-Error fallback via getErrorMessage(error) had no test. Same root cause as F3 — the existing test covered new Error('DB connection lost') but not a non-Error rejection.

Why we missed it: The pattern is identical to F3. The issue is systemic: when adding getErrorMessage() to a catch block, we checked the Error-typed test but not the non-Error fallback.

What would have prevented it: Treat getErrorMessage() adoption as a flag to add both an Error test and a non-Error test. The utility exists specifically for the non-Error case; if you don't test that case, the utility's purpose is untested.
