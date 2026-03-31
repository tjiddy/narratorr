---
scope: [core]
files: [src/core/utils/map-network-error.ts, src/core/utils/fetch-with-timeout.ts]
issue: 227
source: review
date: 2026-03-31
---
`AbortSignal.timeout()` throws `DOMException` with name `TimeoutError`, not `AbortError`. Manual `AbortController.abort()` throws `AbortError`. Both must be handled when mapping timeout errors. The test used `AbortError` which masked the real runtime behavior. Always verify the exact DOMException name thrown by the API being used.
