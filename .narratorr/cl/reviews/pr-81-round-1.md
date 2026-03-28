---
skill: respond-to-pr-review
issue: 81
pr: 91
round: 1
date: 2026-03-25
fixed_findings: [F1, F2, F3, F4, F5, F6]
---

### F1: Section shells hidden when lists empty
**What was caught:** PathStep hid both section containers behind `list.length > 0`, violating the AC requiring sections to always render.
**Why I missed it:** Misread "renders without content" as "renders nothing". Red/green cycle for empty-state rendering was skipped.
**Prompt fix:** Add to /implement step 4a: "For AC items describing UI state during loading/empty conditions, the red test must be the empty/loading state render — not just the happy path. Write the empty-state test stub first."

### F2: demoteToRecent missing MAX_RECENTS cap
**What was caught:** Non-collision branch in `demoteToRecent` didn't slice to MAX_RECENTS, allowing 16+ entries.
**Why I missed it:** Cap was applied in `addRecent` but not propagated to other array-growth paths. No test for cap-on-demotion was written before implementation.
**Prompt fix:** Add to /implement step 4d: "After implementing a bounded-collection operation, grep for all code paths that grow the same collection and verify each one also enforces the bound. Enumerate them — don't use 'e.g.'."

### F3: readStorage accepted entries without lastUsedAt
**What was caught:** `readStorage` filtered only on `path`, allowing malformed entries that crash `sortByRecency`.
**Why I missed it:** Partial guard — validated the first field but not the second one that was immediately dereferenced downstream.
**Prompt fix:** Add to /implement step 4b: "When writing a filter/validator for collection entries, trace every field read downstream of the filter and verify each is also validated in the filter."

### F4: onScanSuccess callback not tested at hook level
**What was caught:** New hook option had page-level coverage only; hook-level branches (success/no-discoveries/rejection) untested.
**Why I missed it:** Page-level test gave false confidence. Hook-level test file wasn't updated when the hook gained new API surface.
**Prompt fix:** Add to CLAUDE.md testing standards: "When a hook gains new options/callbacks, update the hook's test file as part of the same red/green cycle — do not rely on page-level tests as hook-level coverage."

### F5: Seeding effect not asserted at page level
**What was caught:** Loading/error state tests verified no-crash but never asserted seedLibraryRoot was/wasn't called.
**Why I missed it:** "Doesn't crash" tests were used as a template without checking what new behaviors they needed to assert.
**Prompt fix:** Add to /implement step 4a: "For each new effect or side effect wired at the page level, write at minimum: one test that asserts it fires, one that asserts it doesn't fire in the non-triggering state."

### F6: Date formatting untested
**What was caught:** `formatDate()` output was a spec-required format but had no assertion test.
**Why I missed it:** Formatter treated as implementation detail. The `hidden group-hover:block` CSS made the rendered text easy to overlook as a test target.
**Prompt fix:** Add to /implement step 4a: "Any formatter or display transform where the output format is spec-required (e.g., 'date displays as Mar 5, 2026') must have a test that passes a known input and asserts the exact output string."
