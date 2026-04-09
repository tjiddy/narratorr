---
scope: [backend]
files: [src/server/services/refresh-scan.service.ts, src/server/services/enrichment-utils.ts]
issue: 444
date: 2026-04-09
---
`enrichBookFromAudio()` has fill-if-empty semantics: narrator only fills when `!book.narrators?.length`, duration only fills when `!book.duration`, cover only extracts when `!book.coverUrl`. Refresh-scan needs overwrite semantics for narrator and duration. Rather than adding a `mode` parameter to `enrichBookFromAudio` (which has 5 callers with fill-if-empty expectations), creating a separate function avoids risk to existing import/merge/library-scan flows. The overwrite function is simpler — it doesn't touch cover art at all (passes `skipCover: true`).
