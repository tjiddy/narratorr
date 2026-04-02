---
scope: [scope/backend, scope/frontend]
files: [src/server/services/indexer.service.ts, src/server/routes/search-stream.ts, src/client/hooks/useSearchStream.ts]
issue: 298
source: review
date: 2026-04-02
---
The cancelled-indexer path lacked tests across all three layers (service `onCancelled` callback, route `indexer-cancelled` SSE frame, hook state update). Each link was individually correct but deleting any one would leave cancelled indexers stuck in `pending` while tests pass. Future: for cross-layer event chains (service → route → hook), add at least one test per layer that asserts the contract at that boundary.
