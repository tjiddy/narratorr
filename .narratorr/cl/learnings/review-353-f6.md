---
scope: [infra]
files: [scripts/lib.ts]
issue: 353
source: review
date: 2026-03-15
---
When a function stashes, checks out another commit, does work, then returns early on failure, the stash pop must be in the `finally` block — not after it. An early `return` inside a `try` block bypasses code after the `finally`, leaving the developer's worktree stashed. The pattern: use a flag variable (`mainLintFailed`) and check it after the `finally` block instead of returning early inside the `try`.
