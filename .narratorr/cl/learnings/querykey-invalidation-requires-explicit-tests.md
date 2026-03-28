---
scope: [frontend]
files: [src/client/pages/activity/useActivity.ts, src/client/pages/activity/useActivity.test.ts]
issue: 54
date: 2026-03-21
---
Cache invalidation patterns (queryClient.invalidateQueries with specific keys) are not automatically verified by integration tests that only check API call counts and toast messages. When an AC explicitly specifies which queryKeys must be invalidated, add a dedicated test that spies on `queryClient.invalidateQueries` and asserts the exact keys. Use `createWrapperWithClient()` to expose the QueryClient instance for spying.
