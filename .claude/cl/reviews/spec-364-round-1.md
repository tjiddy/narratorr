---
skill: respond-to-spec-review
issue: 364
round: 1
date: 2026-03-14
fixed_findings: [F1, F2, F3, F4, F5]
---

### F1: M-24 targets wrong abstraction
**What was caught:** Spec proposed creating `useLibraryFilters()` when it already exists; incorrectly included LibraryActions as a filter/sort consumer.
**Why I missed it:** `/elaborate` relied on the debt scan summary instead of reading actual component source. The explore subagent was told to check interfaces and touch points but didn't verify whether the proposed fix was already partially implemented.
**Prompt fix:** Add to `/elaborate` step 3 subagent prompt: "For each proposed fix in the issue findings, verify whether the fix target already exists (e.g., if the fix says 'extract hook X', check if hook X already exists). For each child component mentioned, read its props interface to confirm it actually consumes the state being discussed."

### F2: Non-deterministic test plan item
**What was caught:** Test plan included "adding a new filter only requires adding to the context" — not a testable assertion.
**Why I missed it:** Mixed up implementation guidance with test plan items during gap-fill.
**Prompt fix:** Add to `/elaborate` step 4 test plan gap-fill instructions: "Every test plan item must describe an observable pass/fail behavior that can be verified with RTL/Vitest. Architectural aspirations ('easy to extend', 'only requires one file change') belong in implementation notes, not the test plan."

### F3: Missing author-tab coverage
**What was caught:** Issue referenced line 42 (AuthorsTabContent) but test plan only covered book results.
**Why I missed it:** Elaboration noted the line numbers in findings but didn't systematically trace each referenced line into the test plan.
**Prompt fix:** Add to `/elaborate` step 4: "For every file:line reference in the issue findings, verify that the test plan has at least one test case that exercises that specific location. Cross-reference findings → test plan as a final check."

### F4: Composite key examples use non-existent fields
**What was caught:** AC suggested `guid` and singular `author` fields that don't exist on BookMetadata or SearchResult types.
**Why I missed it:** Proposed key strategies without reading type definitions. The explore subagent was asked for "interfaces & types" but the results weren't cross-referenced against AC field references.
**Prompt fix:** Add to `/elaborate` step 4 durable content rules: "When AC or test plan references specific field names on types/interfaces, verify those fields exist by reading the type definition. Never use example field names without confirming they match the actual schema."

### F5: AC/test plan mismatch on loading behavior
**What was caught:** Test plan required loading indicator but AC only mentioned error state.
**Why I missed it:** Noticed both loading and error in source code, promoted error to AC but added loading only to test plan.
**Prompt fix:** Add to `/elaborate` step 4: "After writing test plan items, cross-check: does every test scenario's expected behavior appear in at least one AC item? If a test asserts behavior X, AC must require behavior X."
