---
scope: [backend]
files: [src/server/services/refresh-scan.service.ts]
issue: 444
source: review
date: 2026-04-09
---
`.catch(() => [])` on `readdir()` was copied from `enrichBookFromAudio` where it makes sense (optional enrichment can degrade gracefully). In refresh-scan, the user explicitly requested a rescan — silently persisting `topLevelAudioFileCount: 0` on a transient read failure corrupts metadata and returns 200. When the operation is user-initiated and promises to reflect disk reality, filesystem failures must propagate, not be swallowed.
