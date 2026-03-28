---
skill: respond-to-pr-review
issue: 118
pr: 125
round: 1
date: 2026-03-25
fixed_findings: [F1, F2, F3]
---

### F1: Partial matcher in toggle-off payload test
**What was caught:** The test used `expect.objectContaining({ redownloadFailed: false })` instead of an exact payload assertion, meaning sibling fields could silently regress without test failure.
**Why I missed it:** I added the test targeting only the new field under review, not the full contract. The habit of using `objectContaining` for "just checking the new field" obscures regressions on unchanged fields.
**Prompt fix:** Add to /implement testing standards: "When asserting mutation payloads with `toHaveBeenCalledWith`, always use exact objects — not `expect.objectContaining`. The contract is the full object, not just the changed fields. `objectContaining` is appropriate only when the payload is genuinely open-ended (e.g., DB rows with auto-generated timestamps you can't predict)."

### F2: Recovery test only asserted DB write, not `recoverBookStatus` execution
**What was caught:** The test for `redownloadFailed=false` in `handleMissingItem` path only checked `status: 'failed'` in the DB update, but didn't prove `recoverBookStatus` actually ran and reverted the book status.
**Why I missed it:** I focused on the new `errorMessage: 'Redownload disabled'` write as the observable consequence of the new code path, missing that `recoverBookStatus` is an equally important side effect of the `redownload_disabled` return path.
**Prompt fix:** Add to /plan test stub generation: "For functions that return early with a named outcome (e.g., `'redownload_disabled'`), test ALL side effects of that path — not just the one added in this change. Check what existing code runs before or after the new gate and assert those effects too."

### F3: Only one of two entry points to `handleDownloadFailure` tested for the new gate
**What was caught:** The `redownloadFailed=false` tests only covered the null-download path (`handleMissingItem`), missing the error-status transition path (`handleFailureTransition` → adapter returns `{status: 'error'}`).
**Why I missed it:** When `handleDownloadFailure` is shared by multiple callers, I wrote tests that exercised the function directly but only set up one calling path. The blast radius of a gate change spans all callers, not just the one I thought to test.
**Prompt fix:** Add to /plan step (codebase explore): "When adding a gate/guard to a shared helper function, grep for ALL callers and add at least one test per call site. Shared functions with multiple entry points require coverage from each distinct call path."
