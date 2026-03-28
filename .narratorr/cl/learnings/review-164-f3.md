---
scope: [scope/frontend]
files: [src/client/pages/settings/SecuritySettings.test.tsx]
issue: 164
source: review
date: 2026-03-28
---
The ApiKeySection regenerate test only asserted the API call and dialog close, not the caller-specific successMessage or errorMessage values passed to useMutationWithToast. If either string changed, the test would still pass. Prevention: for every useMutationWithToast caller, tests must explicitly assert toast.success(exactMessage) on success and toast.error(exactMessage) on failure — not just that the mutation ran.
