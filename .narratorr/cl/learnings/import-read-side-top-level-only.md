---
scope: [backend]
files: [src/server/routes/books.ts, src/server/utils/paths.ts, src/client/pages/book/BookDetails.tsx, src/server/services/enrichment-utils.ts]
issue: 237
date: 2026-03-31
---
All import read-side consumers (file listing API, rename, canMerge UI gate) are top-level-only — they use single `readdir()` without recursion. Only `enrichBookFromAudio()` scans recursively for quality stats but also computes a separate `topLevelAudioFileCount`. Any import write-side change must ensure files land at the top level of `books.path` or all these consumers need updating.
