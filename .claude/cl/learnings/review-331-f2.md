---
scope: [backend]
files: [src/server/services/recycling-bin.service.ts]
issue: 331
source: review
date: 2026-03-10
---
`moveFiles()` used `mkdir(toPath)` instead of `mkdir(dirname(toPath))`. On same-filesystem moves, `rename(src, dest)` fails with EPERM/ENOTEMPTY when `dest` already exists as a directory. The contract should be: create the parent directory so rename can atomically place the source at the destination path. This is different from the EXDEV fallback path where `cp` handles existing destination directories. Pattern: for directory moves, always mkdir the *parent*, never the destination itself.
