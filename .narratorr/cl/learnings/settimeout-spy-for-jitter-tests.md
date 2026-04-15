---
scope: [core]
files: [src/core/download-clients/retry.test.ts]
issue: 593
date: 2026-04-15
---
Testing jitter/delay without `useFakeTimers` avoids TanStack Query deadlock issues. Instead, `vi.spyOn(globalThis, 'setTimeout')` captures the delay value while immediately executing the callback via `originalSetTimeout(fn, 0)`. This lets you assert delay bounds without blocking the test on real timers or fighting fake timer interactions with other async code.
