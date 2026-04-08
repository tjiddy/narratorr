---
scope: [backend]
files: [src/server/services/library-scan.service.ts]
issue: 426
date: 2026-04-08
---
CODEC_REGEX uses the global flag (`/gi`), so `.test()` advances `lastIndex`. When calling `.test()` inside a conditional that also uses the same regex, you must reset `CODEC_REGEX.lastIndex = 0` afterward — otherwise the next call to `.test()` in a different invocation of `cleanName()` may start from the wrong position and produce incorrect results.
