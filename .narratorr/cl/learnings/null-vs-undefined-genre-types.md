---
scope: [backend]
files: [src/server/services/book.service.ts]
issue: 350
date: 2026-04-04
---
`trackUnmatchedGenres` accepts `string[] | undefined` but `Partial<NewBook>` yields `string[] | null` for genres (DB schema uses nullable JSON). The mismatch causes TS2345. Fix: coalesce with `?? undefined` at the call site. This null-vs-undefined boundary between Drizzle types and utility functions is a recurring pattern.
