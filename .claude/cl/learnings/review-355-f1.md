---
scope: [backend, services]
files: [src/server/services/book.service.ts]
issue: 355
source: review
date: 2026-03-14
---
When creating a "slim" select projection, enumerate the full schema columns and subtract only the excluded ones — don't build an include list from memory. The slim select for BookService missed `size` and all `audio*` fields because they weren't in the mental model of "important list fields." The library UI uses those fields for quality/format display. Use the schema definition as the source of truth and subtract explicitly.
