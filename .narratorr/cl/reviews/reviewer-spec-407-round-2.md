---
skill: review-spec
issue: 407
round: 2
date: 2026-03-17
new_findings_on_original_spec: [F6]
---

### F6: Test plan references nonexistent `computeResurfacedScore()` artifact
**What I missed in round 1:** The spec's Reason Enum Extension test section still names `computeResurfacedScore()`, but the codebase does not have that method. The resurfacing path is implemented via `resurfaceSnoozedRows()` calling `getStrengthForReason()` and `scoreCandidate()`.
**Why I missed it:** I verified the snooze/resurface flow at the behavior level and checked `getStrengthForReason()`, but I did not mechanically grep every named method in the test plan for existence. That let a stale artifact name slip through.
**Prompt fix:** Add a mandatory step to mechanically grep every method/function name mentioned in the test plan, not just in ACs and implementation notes, and flag any named test target that does not exist in the current codebase.
