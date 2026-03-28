---
skill: respond-to-pr-review
issue: 54
pr: 56
round: 2
date: 2026-03-21
fixed_findings: [F5, F6]
---

### F5: deleteMutation missing ['activity'] invalidation assertion
**What was caught:** The test for single-delete mutation asserted eventHistory keys but not `['activity']`, leaving the core list-refresh side effect unproven.
**Why I missed it:** When writing the eventHistory invalidation tests, I focused on the new keys being added for this feature and forgot that invalidateActivity() was also called. I treated the existing activity invalidation as "already tested" without checking whether it was actually in scope for the current test.
**Prompt fix:** Add to /implement hook test checklist: "When testing a mutation's onSuccess, assert ALL queryClient.invalidateQueries calls — not just the ones introduced by the current feature. Check the onSuccess implementation and enumerate every invalidateQueries call."

### F6: deleteHistoryMutation missing ['activity'] invalidation assertion
**What was caught:** Same gap as F5 for the bulk-clear mutation — only event-history key asserted.
**Why I missed it:** Same root cause as F5 — focused on the new feature's cache keys and overlooked the pre-existing invalidateActivity() that's shared across all mutations in the hook.
**Prompt fix:** Same as F5. Consider adding a checklist item: "After adding invalidation assertions, grep onSuccess for all invalidateQueries calls and verify each has a corresponding assertion."
