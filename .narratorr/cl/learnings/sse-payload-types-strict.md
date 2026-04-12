---
scope: [backend]
files: [src/server/utils/safe-emit.ts, src/shared/schemas/sse-events.ts]
issue: 483
date: 2026-04-12
---
The `SSEEventPayloads` mapped type enforces exact payload shapes per event. Test fixtures using `safeEmit` must match the schema precisely (e.g., `download_progress` requires `percentage`, `speed`, `eta` — not `progress`). Read the Zod schema before writing test payloads to avoid typecheck failures.
