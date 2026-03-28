---
scope: [frontend]
files: [src/client/hooks/useEventSource.ts, src/client/components/SSEProvider.tsx]
issue: 283
date: 2026-03-10
---
The browser `EventSource` API does not support `credentials: 'include'` or custom headers, so cookie-based auth doesn't work for SSE. Solution: fetch the API key from `/api/auth/config` and pass it as `?apikey=` query param. The server auth plugin already supports this (auth.ts:50-52). This requires a wrapper component (SSEProvider) that queries the auth config before initializing the EventSource.
