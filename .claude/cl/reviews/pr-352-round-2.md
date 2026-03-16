---
skill: respond-to-pr-review
issue: 352
pr: 374
round: 2
date: 2026-03-14
fixed_findings: [F1]
---

### F1: Branch still includes unrelated #355 artifacts after push-main fix
**What was caught:** The round 1 fix (pushing main to origin) didn't actually remove the #355 commits from the branch's ancestry. `git log origin/main..branch` still showed the merge commit and #355 commit.
**Why I missed it:** I verified with `git diff --name-status origin/main...HEAD` locally which showed clean results, but didn't verify with `git log` that the commit ancestry was also clean. The diff was clean because the merge base was correct, but the branch history still included the unwanted commits.
**Prompt fix:** Add to `/respond-to-pr-review` fix completeness gate: "When a scope finding says 'branch includes unrelated commits,' verify BOTH the diff (`git diff --name-status origin/main...HEAD`) AND the commit log (`git log --oneline origin/main..HEAD`) are clean. If `git log` shows unwanted commits, cherry-pick or rebase — pushing the base branch alone won't fix branch ancestry."
