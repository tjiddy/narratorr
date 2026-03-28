---
scope: [frontend]
files: [scripts/claim.ts]
issue: 161
date: 2026-03-28
---
When `/implement` is run on a branch that is already a feature branch for another issue (e.g., `feature/issue-169-...`), `claim.ts` creates the new branch (`feature/issue-161-...`) but the actual git checkout doesn't switch to it if the claim script only runs `git checkout -b` and git was already on a different feature branch. All implementation commits then land on the wrong branch, and the handoff branch guard fails. Mitigation: always be on `main` before running `/implement`, or explicitly `git checkout main` before starting.
