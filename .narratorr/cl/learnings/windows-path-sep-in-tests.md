---
scope: [core]
files: [packages/core/src/utils/audio-processor.test.ts]
issue: 127
date: 2026-02-23
---
When testing code that builds file paths with `join()`, assertions with hardcoded forward slashes (`/lib/book/file.m4b`) fail on Windows because `path.join` uses backslashes. Use `join()` in test expectations too, or use `path.posix.join` in the source if paths are always Unix-style (e.g., Docker containers). This bit audio-processor tests on the first run.
