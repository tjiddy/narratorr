---
scope: [frontend]
files: [src/client/components/library/BulkOperationsSection.tsx, src/client/components/library/BulkOperationsSection.test.tsx]
issue: 135
source: review
date: 2026-03-26
---

The rename confirmation modal only passed `r.mismatched` to the message function, dropping the `alreadyMatching` value from the `/bulk/rename/count` response. The modal message showed only one count, missing the spec's exact copy: "Rename N books... M books already match and will be skipped."

Root cause: `fetchCountForOp` was written as a `Promise<number>` helper that collapsed all count responses to a single number. For rename, the spec requires both fields to be surfaced.

What would have caught it: reading the spec's modal copy literally and comparing it to `MODAL_LABELS.rename.message`. The test asserted `/5/` (just that the digit appeared) rather than the full approved copy string.

Prevention: When implementing confirmation modals, always assert the exact copy from the spec in tests, not just that a number appears. Use `screen.getByText(/full copy text/i)` instead of `screen.getByText(/digit/)`.
