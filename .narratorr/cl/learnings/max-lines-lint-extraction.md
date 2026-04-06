---
scope: [backend]
files: [src/server/services/merge.service.ts, src/server/utils/stderr-deduplicator.ts]
issue: 368
date: 2026-04-06
---
ESLint max-lines (400) is enforced on service files. When adding substantial queue management logic to an existing service, plan file size from the start. Extraction targets: standalone utility functions (like stderr deduplicator), shared SSE emit helpers (safeEmit pattern reduces 8 lines per emit method to 1). Compacting emit methods with a generic safeEmit wrapper saved ~40 lines but required correct generic typing (`<T extends SSEEventType>(event: T, payload: SSEEventPayloads[T])`) — using `Parameters<...>` extraction caused TS2345.
