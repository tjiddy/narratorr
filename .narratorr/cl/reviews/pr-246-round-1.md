---
skill: respond-to-pr-review
issue: 246
pr: 251
round: 1
date: 2026-03-31
fixed_findings: [F1, F2, F3, F4, F5]
---

### F1: Zero-result form mounted immediately instead of CTA
**What was caught:** The zero-result path rendered ManualAddForm directly instead of a CTA button that opens the form on click.
**Why I missed it:** Applied a different UX pattern to the zero-result path (immediate render) than the results-present path (toggle), even though the spec required the same interaction for both.
**Prompt fix:** Add to `/implement` step 4 general rules: "When implementing the same interaction pattern in two different render paths (e.g., empty state vs populated state), verify both paths use the same interaction model (CTA → toggle → form), not just the same component."

### F2: searchImmediately hardcoded instead of from settings
**What was caught:** ManualAddForm hardcoded `searchImmediately: true` instead of reading quality settings like AddBookPopover does.
**Why I missed it:** Didn't read the existing AddBookPopover resolution logic before implementing the manual add mutation. The spec said "behaves the same" but I didn't verify what "the same" meant concretely.
**Prompt fix:** Add to `/plan` step 3 explore prompt: "When the spec says a new feature should 'behave like' an existing flow, read the existing flow's full implementation and enumerate every value it resolves from settings or user overrides. Include these as explicit wiring requirements in the plan."

### F3: seriesPosition not validated as numeric
**What was caught:** The Zod schema accepted any string for seriesPosition and relied on runtime `Number()` coercion.
**Why I missed it:** Used `z.string().optional()` as a workaround for the zodResolver type issue without adding a `.refine()` for numeric validation.
**Prompt fix:** Add to CLAUDE.md Gotchas: "When using `z.string()` as a workaround for form fields that represent numbers (to avoid `z.preprocess` type widening), always add a `.refine()` for numeric validation — the form field type and the semantic type are different."

### F4: Zero-result form can't close after success
**What was caught:** The zero-result path didn't pass `onSuccess` to ManualAddForm, so the form stayed open with pre-filled title after submission.
**Why I missed it:** F4 is a direct consequence of F1 — since the form was mounted immediately (no toggle state), there was no close mechanism to wire.
**Prompt fix:** Same as F1 — consistent interaction model across render paths.

### F5: Missing caller-level tests for library-scan and discovery
**What was caught:** The spec explicitly required caller-level duplicate tests for `importSingleBook()` and `addSuggestion()`, but only service-level `findDuplicate()` tests were written.
**Why I missed it:** The implementation plan listed these as "adjacent test surfaces" (from spec reviewer suggestion F8) rather than required tests. The distinction between "adjacent" and "required by spec" was lost.
**Prompt fix:** Add to `/implement` step 4 general rules: "When the spec's test plan includes caller-level test cases, those are required — not optional. Cross-reference the spec test plan against the plan's test stubs before starting implementation."
