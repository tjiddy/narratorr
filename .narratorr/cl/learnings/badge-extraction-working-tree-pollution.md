---
scope: [frontend]
files: [src/client/components/Badge.tsx, src/client/components/Modal.test.tsx]
issue: 163
date: 2026-03-27
---
When scripts/claim.ts creates a new branch via git checkout -b, it carries unstaged/untracked working-tree files from the previous branch. Stub test files from another issue (here: Modal.test.tsx from #164) appear on the new branch and block lint (unused imports) and pollute the handoff stub-check. Fix: stash or commit other issue work before claiming. When this happens mid-implementation: restore unstaged with git restore, commit the untracked file with minimal cleanup, and note it explicitly in the PR.
