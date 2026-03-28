---
scope: [frontend]
files: [apps/narratorr/src/client/lib/api/api-contracts.test.ts]
issue: 256
source: review
date: 2026-03-05
---
API wrapper contract tests must verify response pass-through, not just call arguments. A wrapper could transform or drop the returned data and argument-only tests would still pass. Use `expect(result).toBe(data)` with reference equality to ensure wrappers don't silently modify responses.
