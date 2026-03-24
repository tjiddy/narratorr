---
skill: respond-to-pr-review
issue: 57
pr: 61
round: 3
date: 2026-03-24
fixed_findings: [F1]
---

### F1: Branch had merge conflicts with main

**What was caught:** The branch diverged from main as other PRs merged in. The conflict was in `download.service.test.ts` — main added new `describe` blocks at the same end-of-file location where the feature branch added its indexer projection tests. Also, two test mocks in `SearchReleasesModal.test.tsx` needed `indexerName: null` after the rebase brought in the required field.

**Why I missed it:** Handoff did not include a rebase step. The branch was pushed at a point when it was clean, but by the time the review cycle completed (multiple rounds), main had advanced. The `/respond-to-pr-review` workflow doesn't include a "rebase onto main" step before running verify, so the conflict was never surfaced during implementation.

**Prompt fix:** Add to `/respond-to-pr-review` step 1 (after checking out the branch): "Run `git fetch origin main && git merge-base --is-ancestor origin/main HEAD || echo 'BRANCH IS BEHIND MAIN — rebase required before proceeding'`. If the branch is behind main, rebase it first: `git rebase origin/main`, resolve any conflicts, then continue. This prevents merge conflict findings from reaching the reviewer in the first place."
