---
scope: [frontend]
files: [src/client/pages/settings/CredentialsSection.test.tsx, src/client/pages/settings/SecuritySettings.test.tsx]
issue: 8
date: 2026-03-19
---
Adding confirm password fields to a form causes ALL existing form submission tests to timeout — because they don't fill in the new required confirm field, so the mismatch validator (`password !== confirmPassword`) blocks the mutation. When adding validation to an existing form, audit all tests that submit that form and update them to fill in the new fields. The failure mode is silent timeout (not a clear error), making root cause non-obvious.
