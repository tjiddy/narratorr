---
scope: [scope/backend, scope/services]
files: [src/server/services/download.service.ts, src/shared/schemas/sse-events.ts]
issue: 434
source: spec-review
date: 2026-03-18
---
Spec described grab SSE as `download_status_change` + `book_status_change`, but the actual code emits `grab_started` — a first-class SSE type with its own schema, cache invalidation rules, and frontend toast handler. When specifying SSE extraction, read the actual emit calls AND the SSE event schema to identify the correct event types. Don't assume generic event names when domain-specific ones exist.
