---
scope: [backend]
files: [src/server/services/merge.service.ts, src/server/utils/semaphore.ts]
issue: 368
date: 2026-04-06
---
When adding a queue to a service that previously had a synchronous "do-and-return" pattern (mergeBook returning MergeResult), keeping the deprecated sync method alongside the new async queue method causes significant code duplication. The sync method can't delegate to the async executeMerge without double-calling mocked fs operations (readdir consumed during validation, then re-called during execution). Keep both paths but with separate validation — don't try to share validation with executeMerge when the old sync path needs to read filesystem state exactly once.
