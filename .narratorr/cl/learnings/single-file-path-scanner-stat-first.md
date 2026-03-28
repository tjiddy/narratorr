---
scope: [core]
files: [src/core/utils/audio-scanner.ts]
issue: 47
date: 2026-03-21
---
When a scanner/traversal utility uses `readdir()` on a caller-provided path, it silently breaks when the path points to a file (ENOTDIR → caught → returns []). The fix pattern is: `stat(path)` first, check `isFile()`, handle directly, then fall through to `readdir()` for directories. This is the same pattern used in `import-steps.ts:validateSource()`. Single-file downloads from SABnzbd are real (when `storage` field is a direct file path rather than a directory), so `collectAudioFiles` must handle both file and directory inputs.
