---
name: fake-timers-waitfor-conflict
description: vi.useFakeTimers() breaks waitFor() in Testing Library — use act(async () => {}) instead
type: feedback
scope: [frontend]
files: [src/client/hooks/useBulkOperation.test.ts]
issue: 135
date: 2026-03-26
---

`vi.useFakeTimers()` intercepts `setTimeout` globally. `waitFor()` from `@testing-library/react` uses `setTimeout` internally for retries — with fake timers, `waitFor()` never advances its own timeout, causing tests to hang indefinitely.

**Fix:** Replace `waitFor(() => ...)` with `await act(async () => {})` to flush microtask queue (resolved Promises), or manually advance timers before calling `waitFor`.

For advancing the poll interval (2000ms):
```ts
// WRONG — hangs:
await waitFor(() => expect(api.getBulkJob).toHaveBeenCalled());

// CORRECT — flush Promises then advance:
await act(async () => {});  // flush mount effects
await act(async () => { vi.advanceTimersByTime(2000); });  // advance timer + flush
expect(api.getBulkJob).toHaveBeenCalled();
```

**Why:** `act()` flushes the microtask queue (resolved Promises) before returning. Since `setInterval` callbacks schedule Promise work, wrapping `vi.advanceTimersByTime` in `act(async () => {...})` ensures both the timer fires AND the resulting async work completes.

**How to apply:** Any time a test file uses `vi.useFakeTimers()` and needs to test async state updates from hooks, use `act(async () => {})` instead of `waitFor`. Reserve `waitFor` for tests without fake timers.
