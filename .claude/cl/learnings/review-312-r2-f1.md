---
scope: [frontend]
files: [src/client/pages/book/useBookActions.ts, src/client/pages/book/useBookActions.test.ts]
issue: 312
source: review
date: 2026-03-08
---
When writing hook tests that wrap mutations with side effects (cache invalidation, navigation, etc.), always spy on the queryClient and assert specific invalidation calls. Without this, tests pass even if the side effect code is deleted. The pattern: expose queryClient from the test harness via `createTestHarness()` returning `{ queryClient, wrapper }`, then `vi.spyOn(queryClient, 'invalidateQueries')` and assert with the expected query keys.
