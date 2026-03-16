---
scope: [frontend]
files: [src/client/hooks/useEventSource.ts, src/client/pages/activity/useActivity.ts, src/client/hooks/useActivityCounts.ts]
issue: 283
source: review
date: 2026-03-10
---
Module-level mutable state (like `let sseConnected = false`) is not reactive in React. When `refetchInterval` reads `isSSEConnected()`, it captures the value at render time and never re-evaluates when the SSE connection opens. Fix: use `useSyncExternalStore` with a subscribe/notify pattern (Set of listeners, notify on change). Export a `useSSEConnected()` hook that consumer components call, making the polling interval reactive. The non-reactive getter `isSSEConnected()` can remain for non-React contexts.
