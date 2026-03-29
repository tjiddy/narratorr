---
skill: review-pr
issue: 196
pr: 203
round: 2
date: 2026-03-29
new_findings_on_original_code: [F3]
---

### F3: Series continuation reason text branch lacks direct test coverage
**What I missed in round 1:** `querySeriesCandidates()` changed its reason-text branch to use `nearlyEqual(pos, gap.nextPosition)`, but no test asserts the continuation path omits the ` (position X)` suffix or the gap path includes it.
**Why I missed it:** I focused on filtering and scoring because they were the behaviorally broken branches, but I did not apply the same deletion-heuristic test audit to the adjacent reason-text branch in the same function.
**Prompt fix:** Add to `/review-pr` step 7a: "When a changed function builds user-visible text conditionally, require at least one assertion for each changed text branch. If a comparison branch affects both filtering/scoring and text formatting, audit the formatting branch separately instead of assuming the numeric assertions cover it."
