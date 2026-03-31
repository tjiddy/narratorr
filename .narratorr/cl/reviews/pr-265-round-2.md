---
skill: respond-to-pr-review
issue: 265
pr: 269
round: 2
date: 2026-03-31
fixed_findings: [F5]
---

### F5: Dirty-refetch test doesn't trigger real query invalidation
**What was caught:** The test swapped the mock return value but never invalidated the query, so React Query never refetched and the dirty guard was never exercised.
**Why I missed it:** When writing the F1 fix, I assumed swapping `mockResolvedValue` would trigger a re-render with new data, but in the test harness React Query doesn't auto-refetch without an explicit invalidation. The round-1 fix was behavioral (adding `!isDefaultsDirty`) but the test was structural (it passed without actually testing the guard).
**Prompt fix:** Add to `/respond-to-pr-review` step 3 fix verification: "When fixing a useEffect guard (isDirty, isSubmitting), the test must prove the guard prevents the effect. Specifically: (1) trigger the condition that would fire the effect (query invalidation, not just mock swap), (2) wait for the refetch to complete, (3) assert the guarded state was preserved. A test that only asserts local state without triggering the effect is vacuous."
