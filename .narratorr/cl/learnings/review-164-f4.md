---
scope: [scope/frontend]
files: [src/client/pages/settings/CredentialsSection.test.tsx]
issue: 164
source: review
date: 2026-03-28
---
The credentials delete tests used toHaveBeenCalled() for both success toast and error toast, not toHaveBeenCalledWith(exactMessage). This means any string change to the successMessage or errorMessage config would go undetected. Prevention: always assert toast.success and toast.error with exact message strings. toHaveBeenCalled() is insufficient — it proves the call happened but not that the wiring is correct.
