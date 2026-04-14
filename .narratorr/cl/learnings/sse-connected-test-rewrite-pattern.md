---
scope: [frontend]
files: [src/client/hooks/useEventSource.ts, src/client/hooks/useEventSource.test.ts]
issue: 546
date: 2026-04-14
---
When removing a non-reactive getter export (like `isSSEConnected`) that tests depend on, rewrite test assertions to use the reactive hook (`useSSEConnected`) via `renderHook`. The pattern: render a second hook alongside the main hook in the same wrapper, then assert on `connectedResult.result.current` after `act()` state changes. This tests the same state transitions through the production API.
