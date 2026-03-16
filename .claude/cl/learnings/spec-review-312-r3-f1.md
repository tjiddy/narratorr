---
scope: [scope/core]
files: []
issue: 312
source: spec-review
date: 2026-03-08
---
Spec AC10 note claimed `.claude/cl/learnings/` was gitignored and absent from worktrees, but 27 learning files were still tracked in git (added before the gitignore rule or force-added). The gitignore rule existed (`.claude/*` with specific un-ignores) but had no effect on already-tracked files. The respond-to-spec-review round 2 fix introduced this false claim without verifying with `git ls-files`. Prevention: the "verify fixes before writing" step (step 6) should have caught this — `git ls-files .claude/cl/learnings/` would have shown tracked files. The actual fix was `git rm --cached` to enforce the intended gitignore state.
