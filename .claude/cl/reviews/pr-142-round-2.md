---
skill: respond-to-pr-review
issue: 142
pr: 150
round: 2
date: 2026-03-26
fixed_findings: [F1, F2]
---

### F1: waitForJob timeout branch untested
**What was caught:** The helper throws on timeout but no test exercised that code path, so deleting the throw would still leave the suite green.
**Why I missed it:** Implemented the `throw` as a structural correctness fix but didn't apply the "every new branch gets a test" rule to a test-file helper function. Test helpers are production code within tests — their error paths matter.
**Prompt fix:** Add to `/implement` step 3 test-quality checklist: "Test helper functions in test files are subject to the same branch-coverage rule as production code. Any helper with an error/timeout branch must have a test that exercises that path."

### F2: vacuous negative-only waitFor outside→inside transition test
**What was caught:** The outside→inside state-transition test still used `waitFor(() => not.toBeInTheDocument())` as the stabilisation signal after typing the path, which passes vacuously before the state settles.
**Why I missed it:** The issue spec enumerated exactly five guardrail blocks to fix; I swept only those five. The adjacent transition test was in the same describe block but wasn't listed.
**Prompt fix:** Add to `/implement` step 3 guardrail sweep note: "When fixing a named set of vacuous-waitFor blocks, grep the full file for remaining `waitFor(() => expect(...).not.toBeInTheDocument())` patterns and fix all occurrences — don't rely on the spec's enumeration being exhaustive."
