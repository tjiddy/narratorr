---
scope: [backend, services]
files: [src/server/services/library-scan.service.ts]
issue: 114
date: 2026-03-25
---
Changing "skip duplicates silently" to "include duplicates with isDuplicate flag" requires upgrading pre-fetch queries from `select({path})` to `select({id, path})` and switching from `Set` to `Map` to carry the book ID alongside the path. The blast radius is 8+ test files — always grep for the removed field (`skippedDuplicates`) across ALL test files before declaring a module done, because fixture files in unrelated components also contain the old shape.
