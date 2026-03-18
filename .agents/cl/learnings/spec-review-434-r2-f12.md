---
scope: [scope/backend, scope/services]
files: [src/server/services/download.service.ts, src/shared/schemas/event-history.ts]
issue: 434
source: spec-review
date: 2026-03-18
---
Spec added cancel event recording as a side effect, but cancel() doesn't record events today and no cancel event type exists in eventTypeSchema. When specifying orchestrator side effects, verify each side effect actually exists in the current codebase — don't assume symmetric behavior across methods (grab records events, cancel doesn't).
