---
scope: [backend]
files: [src/server/utils/download-path.test.ts]
issue: 350
date: 2026-03-14
---
On Windows, `path.join('/downloads', 'Book')` returns `\downloads\Book` with backslashes. Tests asserting joined paths must use `join()` in assertions too, not hardcoded forward-slash strings. The production code uses `join()` which behaves correctly in Docker/Linux. Alternatively, use `path.posix.join` in production for consistent cross-platform behavior, but that diverges from existing patterns.
