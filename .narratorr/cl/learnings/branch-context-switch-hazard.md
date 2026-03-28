---
scope: [infra]
files: []
issue: 315
date: 2026-03-11
---
After context compaction, the working directory can end up on a different branch than expected (e.g., issue-342 branch instead of issue-315). Always verify `git branch --show-current` before running verify/handoff steps, especially after compaction. Files from the target branch won't exist on the wrong branch, causing confusing "module not found" errors.
