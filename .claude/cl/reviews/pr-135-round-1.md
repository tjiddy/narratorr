---
skill: respond-to-pr-review
issue: 135
pr: 138
round: 1
date: 2026-03-26
fixed_findings: [F1, F2, F3]
---

### F1: Rename modal drops alreadyMatching count
**What was caught:** `fetchCountForOp('rename')` collapsed the two-field response to `r.mismatched`, and the modal message only showed one count instead of both ("Rename N books... M already match and will be skipped.").

**Why I missed it:** `fetchCountForOp` was designed as a generic helper returning `number`, which forced rename to lose data. The test only asserted `/5/` (a digit appears) rather than the full spec copy.

**Prompt fix:** Add to `/implement` step 3 (component testing): "When testing confirmation modals, assert the exact modal message copy from the spec using `screen.getByText(/exact copy regex/)`, not just that a number appears. If the spec modal copy contains multiple data fields, the assertion must capture all of them."

### F2: Failure banner hidden after completion
**What was caught:** `{isRunning && progress.failures > 0 && ...}` hid the banner on completion. Spec says "report at end."

**Why I missed it:** The `isRunning &&` guard felt natural for "while operation is running" — didn't notice it also controlled the post-completion state. The test for completion-with-failures had a trivially passing assertion (button exists) rather than asserting the failure text.

**Prompt fix:** Add to `/implement` step 3 (component testing): "For any component that shows a running-state indicator, write a separate test for the completed state. If the spec says 'show at end' or 'report at end', the completion test must assert the specific text visible after `isRunning` becomes false."

### F3: BulkJobStatus.id instead of jobId
**What was caught:** Spec contract: `{ jobId, type, status, ... }`. Implementation: `{ id, type, status, ... }`. All polling and resume logic consumed `.id` from active-job responses, which would silently fail for any spec-correct client.

**Why I missed it:** Designed the service interface using natural OOP field name (`id`) without cross-checking the spec's serialized field names. POST start endpoints correctly returned `{ jobId }` but the GET status endpoints diverged.

**Prompt fix:** Add to `/implement` step 1 (service design): "Before defining any interface/type for an API response object, copy the field names verbatim from the spec. For each GET endpoint response, verify all spec-named fields are present in the type definition. POST start responses should share field names with GET poll responses where they overlap (e.g., `jobId` is the identity field in both)."
