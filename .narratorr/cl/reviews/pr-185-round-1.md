---
skill: respond-to-pr-review
issue: 185
pr: 193
round: 1
date: 2026-03-28
fixed_findings: [F1, F2, F3, F4]
---

### F1: handleRetry stale-offset observable unproven
**What was caught:** Test only asserted scanDirectory call count, not that post-retry match results actually merged into rows.
**Why I missed it:** Focused on proving the retry action was triggered rather than its observable consequence. The spec explicitly called out "first match result after retry updates row at index 0" but the test didn't assert that.
**Prompt fix:** Add to /implement step 4a: "When the spec says 'observable: X', the test MUST assert X literally. A call-count assertion does not prove an observable state change."

### F2: handleRetryMatch stale-offset observable unproven
**What was caught:** Same issue as F1 — test proved re-invocation but not that the stale offset was actually reset.
**Why I missed it:** Same root cause as F1.
**Prompt fix:** Same as F1.

### F3: LoadingSpinner icon swap unproven
**What was caught:** Tests only asserted disabled/enabled state, not the spinner icon swap.
**Why I missed it:** Treated "shows spinner and disables" as a single assertion when they are two independent behaviors. The AC said "shows spinner AND disables" — both need assertions.
**Prompt fix:** Add to /implement test quality: "When an AC lists multiple observable behaviors joined by 'and', each behavior needs its own assertion. Disabled state does not prove icon presence."

### F4: initialResults fallback tests vacuous
**What was caught:** Both tests would pass even if the fallback logic were deleted, because the preview independently renders the same title.
**Why I missed it:** Didn't consider that `getAllByText(title).length >= 1` could be satisfied by the preview alone without any seeding.
**Prompt fix:** Add to /implement test quality: "Before finalizing an assertion, ask: 'Would this test still pass if the code under test were deleted?' If yes, the assertion is vacuous — find an observable that only exists when the code under test executes."
