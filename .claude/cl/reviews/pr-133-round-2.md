---
skill: respond-to-pr-review
issue: 133
pr: 136
round: 2
date: 2026-03-26
fixed_findings: [F1, F2]
---

### F1: Vacuous no-match deselection test
**What was caught:** The test named "match results merge: no-match rows auto-deselected" never actually drove a no-match result through the async polling path — it only checked initial row state.
**Why I missed it:** The test was written to document intent but the act() block was left empty with a comment about how it "would" work. I didn't verify the test would fail if the production branch were deleted.
**Prompt fix:** Add to /implement testing standards: "Before committing a test for async state-change behavior (setInterval/mutation/query), verify the test fails when the production logic is removed. If deleting the production branch still leaves the test green, the test is vacuous."

### F2: handleRetryMatch has no direct coverage
**What was caught:** The retry-matching recovery path (click → startMatchJob → error clear) had zero test coverage.
**Why I missed it:** I added `handleRetryMatch` as part of the F1 fix but only wrote a test for the error-showing half (match failure → error card appears). I didn't continue the flow to verify the recovery button actually works.
**Prompt fix:** Add to /implement checklist: "Every new retry/recovery control must have a test that: (1) triggers the failure condition, (2) invokes the recovery action, (3) asserts the error state clears, and (4) asserts the underlying API call fires with the expected arguments."
