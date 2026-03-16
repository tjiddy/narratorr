---
scope: [type/chore]
files: [.claude/cl/workflow-log.md, .claude/cl/debt.md]
issue: 352
source: review
date: 2026-03-14
---
Round 1 fix was insufficient: pushing main to origin changed the diff base but didn't change the branch's commit ancestry. The branch still included #355 commits via a merge commit, so `git log origin/main..branch` still showed them. The correct fix was cherry-picking the #352 commits onto a clean origin/main base and force-pushing. When a branch has unrelated commits in its ancestry, rebasing or cherry-picking is required — not just pushing the base branch.
