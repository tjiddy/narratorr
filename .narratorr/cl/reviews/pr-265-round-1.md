---
skill: respond-to-pr-review
issue: 265
pr: 269
round: 1
date: 2026-03-31
fixed_findings: [F1, F2, F3, F4]
---

### F1: Missing dirty guard on defaults reset effect
**What was caught:** The new defaults form's useEffect reset always fires on settings refetch, overwriting unsaved user edits.
**Why I missed it:** The existing path form at line 37 had the `!isDirty` guard, but when writing the new defaults effect I copied the reset pattern without the guard. The self-review checked that the two forms were "independent" but didn't compare their reset effects structurally.
**Prompt fix:** Add to `/implement` step 4 general rules: "When adding a useEffect that resets form state from fetched data, compare it against every existing reset effect in the same file — ensure the same guards (isDirty, isSubmitting) are applied consistently."

### F2: Success test missing query invalidation assertion
**What was caught:** The success test only asserted the toast, not that `queryClient.invalidateQueries` triggered a refetch.
**Why I missed it:** The testing standards say "test the full mutation lifecycle" including "cache invalidation via queryClient.invalidateQueries", but the implementation only checked the toast. The coverage subagent flagged this but I didn't address it.
**Prompt fix:** Add to `/handoff` step 4 coverage review prompt: "For every mutation onSuccess that calls invalidateQueries, verify the test asserts a refetch consequence (e.g., getSettings called again), not just the toast."

### F3: Success test missing dirty-state reset assertion
**What was caught:** No test verified that the Save button disappears after successful save.
**Why I missed it:** The pending-state test verified the button during submission but not after completion. The "full mutation lifecycle" standard covers this but it wasn't applied.
**Prompt fix:** Add to test plan template: "For forms with conditional Save buttons (isDirty guard), assert Save button disappears after successful submission."

### F4: Failure test missing recovery assertion
**What was caught:** The error test only checked the toast, not that the form remained recoverable (toggle state preserved, Save button available for retry).
**Why I missed it:** Same lifecycle gap — the error test proved the toast but not the UI's post-error state.
**Prompt fix:** Add to test plan template: "For mutation error paths, assert the form remains in its pre-submission state (user edits preserved, submit button available for retry)."
