---
scope: [scope/api]
files: [src/server/routes/discover.test.ts]
issue: 406
source: review
date: 2026-03-17
---
When a route test stubs a higher-order function like `runExclusive(name, callback)`, asserting `expect.any(Function)` for the callback parameter proves nothing about the actual wiring. The mock swallows the callback and returns a canned value, so if the route passed the wrong callback (or no-op), the test would still pass.

Fix: use `mockImplementationOnce` to execute the captured callback, then assert the underlying service method was called. This proves the callback wiring is correct, not just that *a* function was passed.

Root cause: test gap — the original test focused on the route's external contract (status code, payload shape) without verifying the internal delegation through the new concurrency wrapper.
