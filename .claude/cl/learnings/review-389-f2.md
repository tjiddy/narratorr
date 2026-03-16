---
scope: [scope/frontend]
files: [src/client/hooks/useEventHistory.test.ts]
issue: 389
source: review
date: 2026-03-15
---
New delete and bulkDelete mutations in `useEventHistory` and `useBookEventHistory` had no hook-level test assertions — only the existing `markFailed` mutation had tests.

Missed because: the implementation added mutations following the same pattern as `markFailed` but test coverage only existed for the pre-existing mutation. The test file was not updated to cover the new mutation hooks.

Prevention: /plan test stubs should explicitly enumerate every new mutation hook with its assertion contract (API arg, invalidated keys, toast text). If the source file adds N mutations, the test file should add N×3 tests (success, error, arg verification).
