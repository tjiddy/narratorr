---
skill: respond-to-pr-review
issue: 389
pr: 391
round: 1
date: 2026-03-15
fixed_findings: [F1, F2, F3, F4, F5, F6, F7]
---

### F1: Book-page delete cache invalidation
**What was caught:** `useBookEventHistory.deleteMutation` only invalidated the book-specific key, not the shared eventHistory root.
**Why I missed it:** Copied the invalidation pattern from `markFailedMutation` without considering that deletes affect the global event list, not just the book-scoped view.
**Prompt fix:** Add to /plan step for frontend mutations: "For every mutation that modifies shared data, list all views that display this data and verify each view's query key is invalidated. Cross-reference `queryKeys` definitions."

### F2: Missing hook-level delete mutation tests
**What was caught:** No assertions for deleteMutation or bulkDeleteMutation at the hook level.
**Why I missed it:** Existing test file only covered markFailed; new mutations were assumed covered by page-level tests.
**Prompt fix:** Add to /implement test phase: "Every new useMutation hook must have hook-level tests for: (1) API function called with correct args, (2) query keys invalidated, (3) success toast text, (4) error toast text."

### F3: Clear Errors confirmation untested
**What was caught:** The two-step chained deletion flow for Clear Errors was untested.
**Why I missed it:** Clear All test seemed sufficient since they share the same modal component.
**Prompt fix:** Add to /implement test phase: "When a component has multiple confirmation actions with distinct behavior (different text, different callbacks), each action needs its own test."

### F4: EventHistoryCard delete button untested
**What was caught:** Conditional rendering, click callback, and disabled state for the delete button had no direct component test.
**Why I missed it:** Page-level presence assertion (checking the button exists) felt sufficient.
**Prompt fix:** Add to /implement test phase: "New interactive elements (buttons, toggles) need component-level tests for: callback invocation with correct args, conditional rendering, disabled state."

### F5: BookEventHistory delete wiring untested
**What was caught:** Book details page wires `onDelete` to `deleteMutation.mutate(id)` but no test clicks the button.
**Why I missed it:** Similar to F4 — static render tests were written but interaction tests were not.
**Prompt fix:** Same as F4 — interactive wiring needs click tests, not just render assertions.

### F6: Invalid bulk-delete eventType untested
**What was caught:** Route-level test only covered success paths for bulk delete.
**Why I missed it:** Schema validation was assumed sufficient without explicit negative test.
**Prompt fix:** Add to /implement route test phase: "Every route with schema validation needs at least one negative test (invalid input → 400, service not called)."

### F7: Weak deleteAll filter predicate assertion
**What was caught:** Service test only asserted count and `db.delete` call, not that the where clause actually filtered.
**Why I missed it:** Mock chain returns configured result regardless of predicate, so the test passed without proving the filter was applied.
**Prompt fix:** Add to /implement service test phase: "When testing filtered queries/deletes, assert the predicate passed to where() — not just the returned count. Use the Drizzle queryChunks inspection pattern from pruneOlderThan tests."
