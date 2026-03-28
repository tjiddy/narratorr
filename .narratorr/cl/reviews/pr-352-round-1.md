---
skill: respond-to-pr-review
issue: 352
pr: 374
round: 1
date: 2026-03-14
fixed_findings: [F1]
---

### F1: Unrelated .narratorr/cl/* artifacts from #355 in PR diff
**What was caught:** The PR diff included `.narratorr/cl/debt.md`, `.narratorr/cl/workflow-log.md`, and 4 learning files from issue #355 because local main was ahead of origin/main.
**Why I missed it:** The /handoff self-review checked behavioral correctness and AC coverage but didn't verify whether the PR diff included only in-scope files. The `git diff --name-status origin/main...HEAD` check wasn't part of the handoff flow.
**Prompt fix:** Add to `/handoff` step 2 (author self-review): "Run `git diff --name-status origin/main...HEAD` and verify every file in the diff is in scope for the linked issue. If unrelated files appear (e.g., from local main being ahead of origin/main), push main first or rebase to exclude them."
