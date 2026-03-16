---
scope: [backend]
files: [src/server/services/recycling-bin.service.ts]
issue: 331
source: review
date: 2026-03-10
---
Restore from recycling bin dropped the author relationship. The recycle snapshot stored `authorName` and `authorAsin` but the restore path only inserted scalar book fields without finding/creating an author or setting `authorId`. This was a spec gap — the spec said "re-creates book in DB with snapshot metadata" but didn't explicitly call out author relationship restoration, and the implementation took that literally. When restoring records that have FK relationships, always check whether related records need to be found-or-created, not just the primary record's scalar fields.
