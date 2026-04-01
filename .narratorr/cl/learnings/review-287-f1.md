---
scope: [frontend]
files: [src/client/pages/library/helpers.test.ts]
issue: 287
source: review
date: 2026-04-01
---
When fixing a generic helper used by both string and numeric paths, test coverage must exercise both type branches — not just the one that motivated the fix. The compareNullable change affected all nullable fields (string: narrator, series; numeric: size, quality) but tests only covered string fields. Reviewer caught the gap. Prevention: after any helper change, enumerate all callers/field types and ensure each has a representative test.
