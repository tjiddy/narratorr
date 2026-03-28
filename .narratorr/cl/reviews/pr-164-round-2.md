---
skill: respond-to-pr-review
issue: 164
pr: 173
round: 2
date: 2026-03-28
fixed_findings: [F5]
---

### F5: API key regenerate test did not assert auth.config refetch from queryKey wiring
**What was caught:** The round-2 test asserted toast and dialog-close but not that queryKey: queryKeys.auth.config() caused getAuthConfig to be called again after success, nor that the rendered key updated to the new value.
**Why I missed it:** In round 1 I addressed "success toast and dialog close" as two separate behaviors, treating them as exhaustive. I did not think about queryKey invalidation as a third, distinct observable consequence that needs its own assertion path — I conflated "hook tests cover invalidation" with "this caller is covered", which is wrong because the hook tests cover the mechanism but not the caller-specific queryKey value.
**Prompt fix:** Add to /implement checklist (useMutationWithToast callers): "For each caller, the success test must (a) clear the invalidated query mock before the action, (b) assert the query is called again after success, and (c) if the UI renders data from that query, assert the rendered value updates. Toast-only assertions do not prove queryKey wiring."
