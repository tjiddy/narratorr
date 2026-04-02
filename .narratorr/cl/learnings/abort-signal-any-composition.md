---
scope: [core]
files: [src/core/indexers/fetch.ts, src/core/indexers/proxy.ts, src/core/indexers/myanonamouse.ts]
issue: 298
date: 2026-04-02
---
When adding caller-provided AbortSignal to functions that already use internal timeout AbortControllers, compose them with `AbortSignal.any([internalController.signal, callerSignal])`. This is available in Node 20+ and preserves both timeout and caller cancellation semantics. The composed signal should be used in place of `controller.signal` for the fetch call. The internal timeout `clearTimeout` cleanup still works in the `finally` block.
