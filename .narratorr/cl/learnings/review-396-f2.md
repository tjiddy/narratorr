---
scope: [backend, services]
files: [src/server/utils/cover-cache.ts]
issue: 396
source: review
date: 2026-04-07
---
Cover cache `preserveBookCover` used `copyFile` but never cleaned stale siblings with different extensions. If a book's cover changes from jpg to png across wrong-release cycles, both files exist in the cache and `readdir` returns whichever the filesystem lists first — nondeterministic. Fix: before copying the new cover, remove any existing cover files with different extensions. The "idempotent overwrite" test only covered same-extension, masking the cross-extension gap.
