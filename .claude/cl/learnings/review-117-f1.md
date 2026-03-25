---
scope: [scope/backend]
files: [src/server/jobs/monitor.ts, src/server/jobs/monitor.test.ts]
issue: 117
source: review
date: 2026-03-25
---
The reviewer caught that the new `errorMessage` write in `processDownloadUpdate()` was not tested together with the retry overwrite path in the same execution flow. The implementation correctly writes the adapter-supplied error message first, then `handleDownloadFailure()` overwrites it with retry-state text — but the tests covered these two behaviors through different entry points: the initial write test used `bookId: null` (no retry path), and the retry tests used `adapter.getDownload() → null` (the "not found" path that never calls `processDownloadUpdate()`).

**Why we missed it:** The spec explicitly required both behaviors on the same execution path ("write errorMessage on initial failure detection, then retry-state text overwrites it"), but when writing tests we covered each side effect in isolation. The ordering contract — that both writes happen in sequence via `processDownloadUpdate()` → `handleFailureTransition()` — was never verified.

**What would have prevented it:** When a spec defines an ordering contract ("A happens before B in the same flow"), the test plan should include a test that exercises the full sequence in a single execution. Partial coverage of each behavior in isolation doesn't prove the ordering. During implementation, check: "does any spec behavior require a sequence of side effects in a single call path? If so, there must be a test that exercises the full sequence end-to-end."
