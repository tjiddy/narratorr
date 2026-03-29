---
skill: respond-to-pr-review
issue: 201
pr: 209
round: 1
date: 2026-03-29
fixed_findings: [F1, F2]
---
### F1: Unmatched-register test never exercises selectedUnmatchedCount > 0
**What was caught:** The test asserted button was disabled, but via selectedCount=0 (wrong branch), not selectedUnmatchedCount>0 (the claimed branch).
**Why I missed it:** The auto-deselection side effect of mergeMatchResults for confidence=none was known but not accounted for when writing the test. The test setup created the state but the side effect immediately undid it.
**Prompt fix:** Add to `/implement` step 4a (Red phase): "For tests that assert disabled/enabled state from a specific condition among multiple conditions, verify the test setup uniquely triggers THAT condition. If the component has multiple disable paths (e.g., selectedCount=0 OR selectedUnmatchedCount>0 OR isMatching), the test must put the system in a state where only the target condition is active."

### F2: reviewCount test doesn't prove selection independence
**What was caught:** Test asserted "1 review" but never changed selection, so it couldn't distinguish a correct implementation from one that incorrectly filters by selection.
**Why I missed it:** The AC phrase "regardless of selection" was treated as a property of the formula to document, not as a behavior to exercise. The test described the property in its name but didn't enact it.
**Prompt fix:** Add to `/implement` step 4a (Red phase): "When a test name contains 'regardless of X' or 'independent of X', the test MUST exercise X (change it) and assert the result is unchanged. A single assertion at the default value of X is not proof of independence."
