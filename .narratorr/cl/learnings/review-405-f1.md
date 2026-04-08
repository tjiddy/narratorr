---
scope: [backend]
files: [src/server/utils/import-helpers.ts]
issue: 405
source: review
date: 2026-04-08
---
When refactoring code that extracts basenames from file paths, always use `path.basename()` instead of `string.split('/').pop()`. The latter breaks on Windows backslash paths. This was caught in review because the original code used `Dirent.name` (always correct) but the refactor introduced manual path parsing. The CLAUDE.md gotcha about Windows path separators in tests also applies to production code path manipulation.
