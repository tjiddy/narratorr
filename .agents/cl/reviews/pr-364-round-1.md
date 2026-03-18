---
skill: respond-to-pr-review
issue: 364
pr: 376
round: 1
date: 2026-03-14
fixed_findings: [F1, F2, F3]
---

### F1: Stable key functions append index unconditionally
**What was caught:** All four key helper functions appended `-${index}` to every key, making them all order-dependent — the exact problem this issue was supposed to fix.
**Why I missed it:** I interpreted "index as tie-breaker suffix" from the spec as "always append index." The spec actually said "index is only acceptable as a last-resort suffix for true duplicates," which means the key function itself should NOT include index — it should be purely field-based.
**Prompt fix:** Add to `/implement` step 4 general rules: "When implementing React key helpers, verify the generated key does NOT include array index by default. Keys must be purely field-based (order-independent). Index should only be added at the call site when collision detection shows two items would produce the same key."

### F2: Delete modal stays open after successful delete
**What was caught:** The ConfirmModal.onConfirm handler called `deleteMutation.mutate()` but never called `setDeleteTarget(null)`, so the modal stayed open.
**Why I missed it:** I focused on replacing manual mutations with the hook but didn't check how sibling settings pages wire the ConfirmModal — they all call `setDeleteTarget(null)` alongside the mutation.
**Prompt fix:** Add to `/implement` step 4d sibling enumeration: "When adopting a shared hook/pattern (e.g., useCrudSettings), grep all existing consumers and verify each wiring point matches — especially ConfirmModal.onConfirm, form submit handlers, and cancel/close handlers."

### F3: Tests assert wrong contract
**What was caught:** Tests expected keys like `'B001-0'` (with index suffix) for uniquely identifiable rows, codifying the order-dependent behavior instead of catching it.
**Why I missed it:** I wrote tests that verified the current (buggy) output rather than the spec contract. Should have written tests that assert same-data-different-position produces the same key.
**Prompt fix:** Add to testing standards: "When testing key/identity generation, always include an assertion that the same input data produces the same output regardless of array position. Test position-independence explicitly, not just output format."
