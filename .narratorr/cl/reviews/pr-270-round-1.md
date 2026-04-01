---
skill: respond-to-pr-review
issue: 270
pr: 286
round: 1
date: 2026-04-01
fixed_findings: [F1, F2]
---

### F1: NZBGet empty-message fallback test too weak
**What was caught:** The empty-message test asserted `toThrow('NZBGet RPC error')` which would pass even if the fallback detail (`JSONRPCError (code 0)`) regressed.
**Why I missed it:** Focused on testing the branch existence (does it throw?) rather than the branch output (what does it throw?). The test was green, so it felt complete.
**Prompt fix:** Add to `/implement` step 4a test depth rule: "For fallback/default branches, the assertion must include the fallback-specific output — asserting just the common prefix or error type is insufficient. If the production code has `message || fallbackDetail`, the test must assert the fallbackDetail string."

### F2: Transmission 409 retry test doesn't prove retry
**What was caught:** The 409-without-header test only asserted `toContain('409')` without proving 2 requests were made or asserting the exact error message.
**Why I missed it:** Treated it as a verification test (does existing behavior work?) rather than a contract test (what exactly happens?). Didn't use a counting handler even though the existing sibling test at line 98 uses a similar pattern.
**Prompt fix:** Add to `/implement` step 4a test depth rule: "For retry/retry-once tests, always use a counting handler to assert the exact number of attempts, and assert the final error message exactly — not just a substring. Look at sibling tests in the same describe block for patterns to follow."
