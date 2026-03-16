---
scope: []
files: [.claude/cl/debt.md, .claude/cl/learnings/]
issue: 312
source: spec-review
date: 2026-03-09
---
CL cleanup ACs referenced gitignored local-only files (debt.md, specific learnings) without naming them concretely. Reviewer running in a worktree couldn't verify the targets existed. Fix: always name exact files/line items for cleanup ACs, and note when targets are gitignored/local-only so the step is conditional.