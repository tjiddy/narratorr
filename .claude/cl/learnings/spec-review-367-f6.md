---
scope: [scope/frontend]
files: []
issue: 367
source: spec-review
date: 2026-03-16
---
Spec said "cannot be claimed until #366 is merged" but didn't address the workflow implication: `/review-spec` approval maps to `status/ready-for-dev`, which would put the issue in the claimable pool while its dependency is still unmerged. Specs with unmerged dependencies need an explicit workflow instruction: "remain at current status until dependency lands, then re-review." The dependency gate must cover both the claiming action AND the label state.
