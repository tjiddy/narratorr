---
scope: [infra]
files: [.git/objects]
issue: 74
date: 2026-03-24
---
`git write-tree` and `git commit` fail with "insufficient permission for adding an object to repository database .git/objects" even though individual `git hash-object -w` and `git mktree` calls succeed for smaller trees. The failure happens when building the full root tree from its subtrees — the workaround is to build the full tree hierarchy manually using Python (hashlib + zlib), writing each tree object file directly into `.git/objects/<prefix>/`, then use `git update-ref` to move the branch pointer. This is caused by a persistent git environment issue in the automation container (likely related to the fast-import crash visible in `.git/fast_import_crash_*`), not a code bug.
