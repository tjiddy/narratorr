---
scope: [scope/frontend]
files: []
issue: 367
source: spec-review
date: 2026-03-16
---
Reviewer caught that the add-to-library route response was documented as `{ bookId: number }` when the actual merged backend returns `{ suggestion, book }` with optional `duplicate: true` and a `409` for already-added. The original spec was written before #366 was implemented, and the response shape was a guess that was never validated against the merged code. Prevention: after a dependency merges, read the actual route handler AND its test file to verify every response shape claim, not just the happy path.
