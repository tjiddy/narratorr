---
scope: [frontend]
files: [src/client/hooks/useEventSource.ts, src/shared/schemas/sse-events.ts]
issue: 514
date: 2026-04-12
---
`sseEventTypeSchema.options` returns a readonly tuple of string literals that can be spread into an array (`[...sseEventTypeSchema.options]`) for runtime use. This eliminates the need for a parallel hardcoded event type list in useEventSource. The import comes through the barrel `../../shared/schemas.js`.
