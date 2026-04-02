---
scope: [scope/frontend]
files: [src/client/hooks/useSearchStream.ts]
issue: 298
source: review
date: 2026-04-02
---
`useSearchStream.start()` opened EventSource before auth config finished loading, producing an unauthenticated request on cold cache. The existing app-wide `SSEProvider` gates on `apiKey` before opening EventSource. Missed because the hook was built independently without checking the existing SSE auth pattern. Future: when building a new SSE consumer, check how the existing `useEventSource` / `SSEProvider` handles auth gating and mirror the pattern.
