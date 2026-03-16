---
skill: respond-to-pr-review
issue: 360
pr: 377
round: 2
date: 2026-03-14
fixed_findings: [F8, F9, F10, F11]
---

### F8-F10: Sentinel test assertions too weak (isEncrypted instead of exact value)
**What was caught:** `isEncrypted()` would pass even if the code encrypted the literal '********' string instead of preserving the stored ciphertext.
**Why I missed it:** Focused on "is the value encrypted" rather than "is it the same encrypted value." The round 1 fix correctly identified the gap but used a property-check (`isEncrypted`) instead of an exact value assertion. Should have thought about what would happen if `resolveSentinelFields` was removed — would the test still pass?
**Prompt fix:** Add to `/respond-to-pr-review` step 3 (fix section): "When adding assertions for value preservation (encryption, passthrough, identity), assert exact equality with the seeded value, not just a property of the result. Ask: 'Would this test still pass if the feature being tested was removed?'"

### F11: Import failure-revert SSE catch uncovered
**What was caught:** Only the success-path SSE catch was tested, not the failure-revert path catch at a different stage of the import flow.
**Why I missed it:** Treated "add SSE debug-log test" as a single concern per file, when the file actually has two independent catch blocks at different flow stages (success emission vs failure-revert emission).
**Prompt fix:** Add to `/implement` AC2-type work: "When a file has multiple independent catch blocks for the same pattern (e.g., SSE emit at different stages), each catch block needs its own test — one test per catch site, not one test per file."
