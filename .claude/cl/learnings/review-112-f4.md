---
scope: [scope/backend]
files: [src/server/routes/books.test.ts]
issue: 112
source: review
date: 2026-03-26
---
The merge route test suite covered NOT_FOUND, NO_STATUS, NO_TOP_LEVEL_FILES, ALREADY_IN_PROGRESS, and FFMPEG_NOT_CONFIGURED, but missed NO_PATH. All 6 MergeError codes are part of the route contract (mapped in ERROR_REGISTRY), so all 6 need route-level coverage.

Why we missed it: tests were written one-per-guard in the order they appear in the service, but NO_PATH (index 2 in mergeBook) was accidentally skipped.

What would have prevented it: mechanically verify that every entry in the ERROR_REGISTRY for a class has a corresponding route test. When adding error codes to an error class, immediately add a test stub for each code.
