---
scope: [backend]
files: [apps/narratorr/src/server/services/tagging.service.test.ts]
issue: 277
date: 2026-03-06
---
When testing functions that use `path.join()` to build file paths, use `expect.stringContaining('filename.tmp.mp3')` instead of exact path matches. This avoids Windows vs Linux path separator mismatches without needing `path.posix.join` in assertions or source code. Simpler than the `join()` in expectations approach from #127.
