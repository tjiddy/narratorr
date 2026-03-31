---
skill: respond-to-pr-review
issue: 235
pr: 244
round: 1
date: 2026-03-31
fixed_findings: [F1, F2, F3]
---
### F1: extractYear() misses years when codec tags trail
**What was caught:** `extractYear()` returns undefined for `__2017__MP3` because codec tags aren't stripped before year matching.
**Why I missed it:** Built `extractYear()` as a simpler version of `cleanName()` without replicating the codec stripping step. The test plan had year extraction tests but none with codec-suffixed inputs — the motivating folder pattern wasn't in the test fixtures.
**Prompt fix:** Add to `/plan` step 3 explore prompt: "For every new helper function that shares logic with an existing function (e.g., both parse folder names), verify it handles the same normalization steps. Check the motivating example from the issue against both functions."

### F2: Duration disambiguation overrides similarity ranking
**What was caught:** `disambiguateByDuration()` re-sorts results by duration distance, throwing away the similarity ranking that was just computed.
**Why I missed it:** Carried forward the original duration disambiguation pattern (which was correct when there was no scoring) without reconsidering whether re-sorting by duration was still appropriate after adding similarity scoring. The spec said "duration still factors into confidence" which should have been a signal that duration's role changed.
**Prompt fix:** Add to `/implement` step 4 general rules: "When adding a new ranking/scoring layer to existing selection logic, verify that downstream selection branches (duration, tiebreakers) don't override the new ranking. Check that 'still factors into' means 'modifies confidence level' not 'can override winner.'"

### F3: Missing score-vs-duration interaction test
**What was caught:** No test case where the better similarity match has worse duration — the gap that would have caught F2.
**Why I missed it:** Wrote tests for scoring and duration separately but not the intersection. The test plan had "Duration + scoring combined" items but they only covered title-floor interactions, not the case where similarity and duration disagree on the winner.
**Prompt fix:** Add to `/plan` test stub extraction: "When a feature adds a new ranking signal alongside an existing one, always generate an interaction test stub where the two signals disagree on the winner. This is the canonical regression test for selection logic."
