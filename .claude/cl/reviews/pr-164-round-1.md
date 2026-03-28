---
skill: respond-to-pr-review
issue: 164
pr: 173
round: 1
date: 2026-03-28
fixed_findings: [F1, F2, F3, F4]
---

### F1: onSuccess callbacks not asserted in RemotePathMappingsSubsection tests
**What was caught:** Create mutation onSuccess (setShowForm(false)) and update mutation onSuccess (setEditingId(null)) had no test assertions verifying the UI state changed.
**Why I missed it:** During the migration, I focused on verifying the mutation itself ran and the toast fired. I did not consider that the onSuccess callback is the NEW behavioral contract introduced by the migration — the old raw useMutation had these callbacks inline and they were equally untested, but migrating to useMutationWithToast made it more explicit.
**Prompt fix:** Add to /implement step (migration checklist): "For each useMutationWithToast caller, the test must assert the outcome of any onSuccess/onError callback — not just the API call and toast. If onSuccess calls setShowForm(false), assert the form is no longer rendered. If it calls setEditingId(null), assert the edit form is gone."

### F2: AuthModeSection confirmation dialog state not asserted after success/error
**What was caught:** Tests asserted toast, refetch, and mutation args but did not verify the confirmation dialog disappears after success or error.
**Why I missed it:** I treated the confirmation dialog close as an implementation detail rather than a user-visible observable behavior. The test was structured around the mutation call, not the complete user flow.
**Prompt fix:** Add to CLAUDE.md test standards: "For confirmation dialog patterns, always assert the dialog is NOT present after the mutation settles on both success and error paths. Use queryByRole or queryByText with .not.toBeInTheDocument()."

### F3: ApiKeySection success/error toast messages not asserted
**What was caught:** The regenerate test only verified the API call happened and the dialog closed. Neither the specific successMessage nor a failure path were tested.
**Why I missed it:** I added the dialog-close assertion (from the handoff coverage review) but missed that the toast and error path were also uncovered.
**Prompt fix:** Add to /implement checklist: "Every useMutationWithToast caller must have: (a) a test asserting toast.success(exactSuccessMessage), (b) a test asserting toast.error(exactErrorMessage) on failure. toHaveBeenCalled alone is never sufficient."

### F4: CredentialsSection delete toast not asserted with exact values
**What was caught:** toast.error and toast.success were asserted with toHaveBeenCalled() rather than toHaveBeenCalledWith(exactMessage).
**Why I missed it:** Existing tests used toHaveBeenCalled() and I did not strengthen them when migrating — I only verified the migration did not break existing tests rather than thinking about whether the existing tests were strong enough.
**Prompt fix:** Add to CLAUDE.md: "toHaveBeenCalled() for toast assertions is a code smell. Every toast.success and toast.error assertion must use toHaveBeenCalledWith(exactString). This applies when migrating existing code, not just writing new tests."
