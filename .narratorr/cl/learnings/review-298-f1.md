---
scope: [scope/frontend]
files: [src/client/hooks/useSearchStream.ts]
issue: 298
source: review
date: 2026-04-02
---
`showResults()` only cancelled pending indexers but did not set `phase = 'results'`, leaving the user stuck in Phase 1 until the backend sent `search-complete`. The spec explicitly required immediate transition. Missed because the implementation assumed the server-side `search-complete` event would arrive quickly after cancellation, but the user expectation is instant UI transition. Future: when a spec says "transitions immediately", the hook must set phase locally, not wait for a server round-trip.
