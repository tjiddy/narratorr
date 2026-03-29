---
skill: respond-to-pr-review
issue: 197
pr: 204
round: 1
date: 2026-03-29
fixed_findings: [F1, F2]
---

### F1: Catch block wraps all errors as INVALID_ZIP
**What was caught:** The backup restore catch block converted all unexpected errors (including system I/O errors like ENOSPC) into `RestoreUploadError('INVALID_ZIP')`, hiding operational failures behind a bad-archive message.
**Why I missed it:** When removing the 4-string `message.includes()` chain, I took the shortcut of wrapping everything as INVALID_ZIP instead of preserving the distinction between format errors and system errors. The self-review didn't flag this because it evaluated the contract at the "does it remove message.includes" level, not the "does it preserve error classification" level.
**Prompt fix:** Add to `/implement` step 4 general rules: "When replacing string-based error classification in catch blocks, verify that the new code preserves the distinction between format/validation errors (translated to typed errors) and system/operational errors (re-thrown unchanged). Check for `NodeJS.ErrnoException.code` as the discriminator."

### F2: Missing test for non-zip error rethrow
**What was caught:** No test verified that system-level I/O errors escape the catch block unchanged.
**Why I missed it:** The test plan in the spec said "non-zip-related error → re-thrown" but I didn't write a test for it because I eliminated the entire classification path (no distinction = no branch to test).
**Prompt fix:** Add to `/implement` step 4a red-phase: "When a catch block has multiple error classification paths (translate vs rethrow), write tests for EACH path — including the rethrow path. A catch block that translates some errors and rethrows others has at minimum 2 test cases per error type."
