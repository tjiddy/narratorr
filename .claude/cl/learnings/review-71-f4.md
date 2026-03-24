---
scope: [backend, api]
files: [src/server/routes/books.ts, src/server/routes/books.test.ts]
issue: 71
source: review
date: 2026-03-24
---
When an issue adds a new column to an event/history table (e.g., `book_events.narrator_name`), every event creation site that omits the new field is a regression. After migrating to arrays (authors[], narrators[]), delete-route event creation was only updated to call `.map(a => a.name).join(', ')` for authorName but never wired up narratorName at all. Always grep for all `eventHistory.create(` calls after adding a new field to `CreateEventInput` and verify each site passes the new field.
