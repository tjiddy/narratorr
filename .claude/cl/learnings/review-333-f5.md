---
scope: [frontend]
files: [src/client/lib/api/system.ts, src/client/lib/api/api-contracts.test.ts]
issue: 333
source: review
date: 2026-03-10
---
Reviewer caught that `dismissUpdate()` had no API contract test despite being a new mutation. `api-contracts.test.ts` already had `getSystemStatus()` coverage but the new method was missed. Lesson: every new API client method needs a contract test asserting path, method, body, and return value pass-through — check the contracts test file when adding any new API method.
