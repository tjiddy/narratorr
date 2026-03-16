---
scope: [type/chore]
files: [.claude/cl/workflow-log.md, .claude/cl/debt.md]
issue: 352
source: review
date: 2026-03-14
---
Branch was created from local main which was ahead of origin/main by 2 commits (from #355). This caused the PR diff to include unrelated `.claude/cl/*` artifacts. Fix: push main to origin before creating feature branches, or verify `git diff --name-status origin/main...HEAD` only shows in-scope files before handoff. The /handoff self-review caught all behavioral issues but didn't check whether non-skill files in the diff were out of scope.
