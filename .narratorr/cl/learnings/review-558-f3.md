---
scope: [core]
files: [src/core/download-clients/blackhole.ts, src/core/download-clients/blackhole.test.ts]
issue: 558
source: review
date: 2026-04-15
---
When adding typed error wrapping to an adapter's network calls, the test file must be updated to assert the new error types — not just rely on message substring matching. A `toThrow('HTTP 404')` assertion passes for both raw `Error` and `DownloadClientError` since both carry the message, so it doesn't prove the typed wrapper is working. Always add `toBeInstanceOf(TypedError)` assertions for newly introduced error types.
