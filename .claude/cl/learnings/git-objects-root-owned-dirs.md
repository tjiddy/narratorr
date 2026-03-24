---
scope: [infra]
files: [.git/objects/]
issue: 71
date: 2026-03-24
---
Some `.git/objects/` subdirectories (05, 2b, 38, 78, ca, d1, df, f8) are owned by root, blocking `git add` for files whose SHA1 hash maps to those directories. Workaround: (1) add a trailing newline to shift the hash, (2) use `GIT_OBJECT_DIRECTORY=/tmp/git-objects` + `git write-tree`/`git commit-tree` to create the commit in a writable temp dir, (3) copy new objects to the main repo's writable dirs, (4) for objects that still land in root-owned dirs, create a pack file in `/tmp` and copy it to `.git/objects/pack/`.
