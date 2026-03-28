---
scope: [frontend]
files: [src/client/pages/activity/ActivityPage.test.tsx, src/client/pages/activity/useActivity.test.ts]
issue: 58
date: 2026-03-22
---
To test that optimistic UI changes happen *before* an API response, use a deferred promise: `let resolve; vi.mocked(api.fn).mockReturnValue(new Promise(r => { resolve = r; }))`. Click the action, assert the intermediate UI state (card gone, button disabled), then call `resolve()` or `rejectFn()` and assert the final state. Tests that only assert after resolution cannot prove the timing guarantee — a fast-resolving mock passes both correct and incorrect implementations. Act wrapping is needed for the rejection: `act(() => { rejectFn(new Error()); })`.
