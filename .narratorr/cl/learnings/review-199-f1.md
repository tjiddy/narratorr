---
scope: [backend, core]
files: [src/core/notifiers/ntfy.test.ts, src/core/notifiers/pushover.test.ts, src/core/notifiers/telegram.test.ts]
issue: 199
source: review
date: 2026-03-29
---
Network-error tests using MSW's `HttpResponse.error()` produce non-deterministic error messages. Tests that assert `message.not.toBe(X)` instead of `message.toBe(exactValue)` are vacuous — they pass even if the adapter returns a generic fallback string. Always use deterministic mocks (spy with known Error) and assert the exact propagated message.
