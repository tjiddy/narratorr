---
scope: [frontend]
files: [src/client/pages/activity/useActivity.test.ts]
issue: 184
date: 2026-03-29
---
When testing TanStack Query `refetchInterval` with Vitest fake timers, use `vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })` — not bare `vi.useFakeTimers()`. Faking all timers breaks `waitFor` (which uses `setTimeout` internally) and causes tests to hang. The `useManualImport.test.ts` file established this pattern. Additionally, each test must use the try/finally pattern with `vi.useRealTimers()` in `finally`, and must explicitly `unmount()` the hook and `queryClient.clear()` before restoring real timers — otherwise stale polling intervals leak between tests and cause call-count mismatches.
