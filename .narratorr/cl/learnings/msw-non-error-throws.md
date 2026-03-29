---
scope: [backend, core]
files: [src/core/notifiers/ntfy.test.ts, src/core/notifiers/pushover.test.ts, src/core/notifiers/telegram.test.ts]
issue: 199
date: 2026-03-29
---
MSW intercepts thrown non-Error values (strings, null) inside handlers and converts them to 500 responses — the thrown value never reaches the adapter's catch block. To test `catch (error: unknown)` branches where `error instanceof Error` is false, spy on `fetchWithTimeout` directly with `vi.spyOn(fetchModule, 'fetchWithTimeout').mockRejectedValueOnce('string-error')` instead of using MSW handlers.
