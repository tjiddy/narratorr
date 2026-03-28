---
skill: respond-to-pr-review
issue: 353
pr: 380
round: 2
date: 2026-03-15
fixed_findings: [F6, F7]
---

### F6: Stash-leak on main-lint failure path
**What was caught:** `runDiffLintGate()` returned early inside the try block when main-side lint failed, bypassing the stash pop at the end of the function.
**Why I missed it:** Focused on the finally block restoring the branch checkout but didn't trace through the early return path to verify stash pop also happened. The finally block only had checkout, not stash pop.
**Prompt fix:** Add to `/implement` step 4a (Red): "For functions that stash/checkout/pop, trace every return path through the function and verify stash pop runs on each. Early returns inside try blocks bypass code after finally."

### F7: Missing test for main-lint-failure-after-stash path
**What was caught:** The test suite didn't exercise the exact path where branch lint succeeds, stash/checkout happens, then main lint fails.
**Why I missed it:** Wrote the ESLint-failure test for the branch-lint-failure case (before stash) but didn't write a separate test for main-lint failure (after stash), which is the path with the stash-leak bug.
**Prompt fix:** Add to `/implement` test depth rule: "When testing a function with stash/checkout choreography, write a test for failure at EACH stage of the choreography (before stash, after stash but before checkout, after checkout), not just the first failure point."
