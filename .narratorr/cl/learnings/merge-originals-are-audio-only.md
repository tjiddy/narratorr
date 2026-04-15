---
scope: [backend]
files: [src/server/services/merge.service.ts, src/server/services/merge.service.test.ts]
issue: 592
date: 2026-04-15
---
The merge service's `commitMerge` cleanup loop iterates `topLevelAudioFiles` (from `readdir` filtered to audio extensions), not all files in the book directory. Non-audio files like `cover.jpg` are preserved. Test assertions on unlink call counts must account for this filtering — the mock `readdir` returns all files but only audio files reach the unlink loop.
