---
scope: [infra]
files: [src/client/pages/settings/ImportSettingsSection.test.tsx, src/client/pages/settings/SearchSettingsSection.test.tsx]
issue: 362
date: 2026-03-13
---
Unresolved merge conflict markers from a prior `git stash pop` block ALL commits on any branch, not just the branch where the stash was applied. The `claim.ts` script creates a new branch but doesn't check for pre-existing unmerged files. Had to resolve these before committing our changes. Check `git status` for UU (unmerged) files before starting work.
