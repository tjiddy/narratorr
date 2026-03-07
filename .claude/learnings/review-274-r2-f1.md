---
scope: [backend]
files: [src/server/services/import.service.ts]
issue: 274
source: review
date: 2026-03-06
---
The `upgraded` event type was in the spec but the initial implementation only emitted `imported` for all successful imports. The distinction is simple — check `book.path` before the import overwrites it. If the book already has a path, it's an upgrade. This was a spec gap: the implementation didn't map all event types from the schema to actual emission points.
