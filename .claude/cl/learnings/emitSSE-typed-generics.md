---
scope: [backend, services]
files: [src/server/services/quality-gate.service.ts]
issue: 422
date: 2026-03-17
---
When extracting SSE emit helpers, the helper must preserve the generic type constraint from EventBroadcasterService.emit<T extends SSEEventType>(). Using `string` as the event type parameter causes a TS2345 error because the broadcaster expects the typed union. Use `<T extends SSEEventType>(eventType: T, payload: SSEEventPayloads[T])`.
