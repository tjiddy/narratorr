---
scope: [scope/backend, scope/services]
files: [src/server/services/health-check.service.ts, src/server/services/health-check.service.test.ts]
issue: 147
source: review
date: 2026-03-27
---
checkDiskSpace()'s new non-Error fallback via getErrorMessage(error) had no test. The existing test only proved the Error('Permission denied') path. A broken fallback string would not have been caught by the suite.

Why we missed it: getErrorMessage() was added as an improvement to the fallback, but tests were only written for the previously-covered Error case. New getErrorMessage() call paths need their own non-Error test.

What would have prevented it: Any catch block using getErrorMessage(error) introduces a new fallback code path. Add a test where the rejection is a non-Error value (string or plain object) and assert the exact fallback message string.
