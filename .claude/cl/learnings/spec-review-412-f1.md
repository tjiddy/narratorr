---
scope: [scope/infra]
files: []
issue: 412
source: spec-review
date: 2026-03-16
---
AC1 said "UU status" in parenthetical but the scope note listed all unmerged porcelain codes. AC also didn't require the check to run before the existing `git stash` call. The gap: AC text was written as a summary of intent rather than a precise contract — the parenthetical carried the wrong specificity level and the timing constraint was implicit. Would have been caught by verifying AC text against both the scope note and the actual code flow in `checkoutOrCreateBranch()`.
