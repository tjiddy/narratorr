---
skill: respond-to-spec-review
issue: 351
round: 3
date: 2026-03-14
fixed_findings: [F1]
---

### F1: Spec still does not include rendered click-flow test for new pills
**What was caught:** The test plan had hook-level setter assertions but no `LibraryPage.test.tsx` rendered interaction test that clicks the new pills and verifies visible results/empty state.
**Why I missed it:** Rounds 2 and 3 claimed to fix the interaction-level flow finding by adding `useLibraryFilters.test.ts` setter tests, but these are hook-level tests, not rendered click-through tests. The distinction between "hook interaction" (renderHook + act) and "rendered UI interaction" (render full page + userEvent click + DOM assertion) was not properly understood.
**Prompt fix:** Add to `/respond-to-spec-review` step 5: "When fixing a test-plan finding about 'interaction-level' or 'click-through' tests, verify the fix adds a RENDERED component test (render + userEvent + DOM assertion), not just a hook-level test (renderHook + act + return value assertion). Check for existing `<Component>.test.tsx` files and add tests there. Re-read the issue body after updating to confirm the new test section is actually present."
