---
scope: [frontend]
files: [src/client/lib/eventReasonFormatters.tsx, src/client/lib/eventReasonFormatters.test.tsx]
issue: 455
source: review
date: 2026-04-09
---
Reviewer caught that `download_failed` dispatch branch had no test despite being explicitly called out in the spec as conditional behavior. Tests for `import_failed` and `merge_failed` covered the shared ErrorDetails renderer, but didn't prove `download_failed` was wired to it. Each event type in the dispatch map is a separate branch — shared renderer coverage from sibling event types is not sufficient. The test must prove the specific eventType dispatches correctly.
