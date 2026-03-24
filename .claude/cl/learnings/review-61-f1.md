---
scope: [scope/backend, scope/frontend]
files: [src/server/services/download.service.test.ts]
issue: 57
source: review
date: 2026-03-24
---
Reviewer caught that the branch had merge conflicts with main before it could be merged. This was a rebase gap — the feature branch diverged from main as other PRs landed, and the branch was not kept up to date. The conflict was in `download.service.test.ts` where main had added new `describe` blocks (`grab — replaceExisting`, `cancel — reason param`) that sat at the same location as the feature branch's new `indexer name projection (#57)` block. Resolution was to keep both. Would have been prevented by rebasing onto main before handoff or as part of the review-response cycle when main advances.
