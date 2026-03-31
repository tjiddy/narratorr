---
skill: respond-to-pr-review
issue: 240
pr: 245
round: 1
date: 2026-03-31
fixed_findings: [F1, F2, F3, F4, F5, F6]
---

### F1: stripEmptyWrappers removes literal empty wrappers
**What was caught:** The regex `/\(\s*\)|\[\s*\]/g` strips all empty parens/brackets, not just those created by empty tokens.
**Why I missed it:** Tests only covered empty-token cases. No test for literal `()` in a template with all tokens filled.
**Prompt fix:** Add to `/implement` step 4a: "For any new string transformation, always include a negative test that proves the transformation does NOT affect strings that should be untouched — not just strings that should be changed."

### F2-F4: Caller-level bitrate forwarding untested
**What was caught:** import.service, merge.service, and bulk-operation.service all thread `sourceBitrateKbps` through to `processAudioFiles` but had no service-level assertions for the new field.
**Why I missed it:** The coverage subagent flagged this but my fix only added import-steps.test.ts (middle-hop) tests, not service-level tests. Multi-layer forwarding chains need tests at every layer per the review-210-r3 learning.
**Prompt fix:** Add to `/handoff` coverage review prompt: "For multi-layer parameter forwarding (service → helper → processor), verify that EACH layer has an assertion for the new parameter. Middle-hop tests alone are insufficient — each service entry point must also assert it."

### F5: Concurrent test doesn't prove fan-out
**What was caught:** The test only checked both adapters were called, which also passes with sequential execution.
**Why I missed it:** Didn't think about the test from a falsification perspective — "would this test fail if I reverted to the sequential implementation?"
**Prompt fix:** Add to `/implement` step 4a: "For concurrency changes (sequential → parallel), write a test that would FAIL against the old sequential implementation. Use deferred promises to prove concurrent invocation."

### F6: Missing close-path interaction tests
**What was caught:** DownloadClientFields portal wiring had no outside-click or Escape close test.
**Why I missed it:** The z-30 assertion was already there; I assumed ToolbarDropdown's own tests covered the close behavior.
**Prompt fix:** Add to `/implement` step 4a: "When reusing a portal component (ToolbarDropdown), add integration tests that prove the consumer's wiring (triggerRef, onClose) works — component tests for the portal don't guarantee the consumer hooked it up correctly."
