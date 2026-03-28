---
scope: [backend, frontend]
files: []
issue: 421
date: 2026-03-17
---
When `/claim` creates a branch from main while HEAD is on a different feature branch, git may leave HEAD detached or on the old branch. Always `git checkout <branch-name>` explicitly after claim, and verify with `git rev-parse HEAD` that it matches the branch tip before starting work. The handoff coverage review subagent will otherwise pick up diff from the wrong base.
