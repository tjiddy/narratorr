---
scope: [scope/frontend]
files: [src/client/pages/library/useLibraryBulkActions.ts, src/client/pages/library/BulkActions.test.tsx]
issue: 282
source: review
date: 2026-03-10
---
Bulk search toast reported non-wanted book skips as a separate "non-wanted skipped" bucket, but the issue contract defines a single `skipped` count combining both client-side non-wanted skips and API `result: 'skipped'` responses. The test locked in the wrong behavior. Lesson: when the spec defines a specific toast/message format, implement it literally and write the test assertion against the exact spec wording — don't invent extra buckets that "seem more helpful."
