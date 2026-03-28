---
scope: [frontend]
files: []
issue: 363
date: 2026-03-15
---
When an issue has been claimed multiple times (visible from repeated "Claiming #N" comments), always check if the implementation is already complete before starting TDD. The branch may contain full implementation from a previous session that was interrupted before handoff. Checking `git log main..HEAD` first saves significant rework.
