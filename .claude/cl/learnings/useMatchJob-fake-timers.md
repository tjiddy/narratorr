---
scope: [frontend]
files: [src/client/hooks/useMatchJob.ts, src/client/pages/manual-import/useManualImport.test.ts]
issue: 80
date: 2026-03-24
---
`useMatchJob` uses `setInterval` at 2000ms (POLL_INTERVAL). Tests that verify merge-on-arrival behavior need fake timers. Use `vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })` (not full fake timers — that can break Promise resolution) + `await vi.advanceTimersByTimeAsync(2100)` inside `act()` to trigger the first poll. Restore with `vi.useRealTimers()` in a `finally` block.
