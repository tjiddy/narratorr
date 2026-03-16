---
scope: [scope/backend]
files: [src/core/notifiers/types.ts, src/shared/schemas/notifier.ts]
issue: 283
source: spec-review
date: 2026-03-10
---
Spec included `health_change` as a required SSE event type, but no runtime code emits health events -- only notifier type definitions exist with no callers. The elaboration flagged this as underspecified in scope boundaries but still kept it in the AC and event list. Prevention: when elaboration flags "no producer exists," remove the event from AC entirely rather than leaving it in with a vague scope note.
