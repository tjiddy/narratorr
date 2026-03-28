---
scope: [backend, services]
files: [src/server/services/quality-gate.helpers.ts, src/server/services/quality-gate.service.test.ts]
issue: 71
source: review
date: 2026-03-24
---
When migrating from a delimited string field to a proper array, ALL consumers must be updated to use the array directly — not join the array back to a string and then re-tokenize it. The quality gate narrator comparison re-joined `book.narrators` to `'; '` and then immediately split on `/[,;&]/`, reintroducing the exact delimiter heuristic the migration was meant to eliminate. Use array `map`/`filter` directly on the new entity array instead. The fix: normalize each `narrator.name` to lowercase from the array directly, then compare against tokenized download tags.
