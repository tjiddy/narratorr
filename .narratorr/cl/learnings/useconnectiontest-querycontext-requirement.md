---
scope: [frontend]
files: [src/client/hooks/useConnectionTest.ts, src/client/hooks/useConnectionTest.test.ts]
issue: 317
date: 2026-04-03
---
Adding `useQueryClient()` to a hook that previously had no TanStack Query dependency breaks all existing tests that use bare `renderHook` without a `QueryClientProvider` wrapper. The test file was `.test.ts` (not `.test.tsx`), so JSX wrappers don't work — use `createElement(QueryClientProvider, { client: queryClient }, children)` instead. Check all callers of a hook before adding provider-dependent hooks to it.
