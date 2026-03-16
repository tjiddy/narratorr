---
scope: [backend, frontend, core]
files: [apps/narratorr/src/shared/schemas.ts, apps/narratorr/src/server/services/import.service.ts, packages/core/src/utils/naming.ts]
issue: 203
source: review
date: 2026-02-23
---
PR included unstaged changes from a prior issue (#199) because the branch was created from a dirty working tree. The scope cleanup required `git reset --soft main` + selective re-staging — painful and error-prone. Prevention: always `git stash --include-untracked` before branching, or verify `git diff --stat main` before pushing to confirm only in-scope changes.
