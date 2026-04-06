---
scope: [backend]
files: [src/server/services/enrichment-utils.ts]
issue: 369
date: 2026-04-06
---
The embedded cover art branch in `enrichBookFromAudio` (line 76) has a strict guard: `!book.coverUrl`. This means books with a remote coverUrl skip embedded cover extraction entirely. The remote-cover download hook must check both `isRemoteCoverUrl(book.coverUrl)` AND `!update.coverUrl` (no embedded cover saved) to avoid triggering downloads for books that just got their embedded cover extracted.
