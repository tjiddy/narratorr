---
scope: [backend]
files: [src/server/utils/sanitize-log-url.ts, src/server/utils/sanitize-log-url.test.ts]
issue: 585
date: 2026-04-15
---
The magnet URI regex expects exactly 32 base32 characters for info hashes (not variable length). When writing test fixtures with base32 hashes, count characters carefully — common example strings from documentation are often shorter than 32 chars, causing false test failures.
