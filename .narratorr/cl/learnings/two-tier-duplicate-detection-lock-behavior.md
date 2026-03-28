---
scope: [frontend, backend]
files: [src/client/components/manual-import/ImportCard.tsx, src/server/services/library.service.ts]
issue: 133
date: 2026-03-26
---
Path duplicates (same filesystem path already in library) must lock both checkbox and edit button — the user cannot fix a path collision by renaming. Slug duplicates (title+author slug collision) must lock only the checkbox, allowing the user to edit title/author to resolve the collision. These two locking behaviors require separate `duplicateReason` tracking on the discovery object, not just a boolean `isDuplicate` flag.
