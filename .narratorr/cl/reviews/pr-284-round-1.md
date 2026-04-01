---
skill: respond-to-pr-review
issue: 284
pr: 285
round: 1
date: 2026-04-01
fixed_findings: [F1, F2, F3]
---

### F1: download-client whitespace-only test didn't verify the empty-string contract
**What was caught:** Test used superRefine-required field (`host`) for whitespace-only assertion, so it only proved parse failure — never verified `''` output for optional fields.
**Why I missed it:** Focused on proving superRefine rejection behavior rather than the positive trim output for truly optional fields. The test "passed" but didn't assert the contract the spec required.
**Prompt fix:** Add to `/implement` step 4a test depth rule: "When testing schema transforms (.trim(), .transform()), assert the transformed output value — not just parse success/failure. Use fields that won't trigger validation side effects (superRefine) to isolate the transform behavior."

### F2: back-and-rescan path update test missing
**What was caught:** Test plan explicitly required "path display updates correctly when user goes back and scans a different directory" but only first-render display was tested.
**Why I missed it:** Wrote 3 tests that felt like they covered the feature (display, styling, absence) but didn't systematically cross-reference with the spec's test plan checklist items.
**Prompt fix:** Add to `/implement` step 4a: "After writing tests for a module, re-read the spec's Test Plan section and verify each test plan item has a corresponding test. Treat test plan items as a checklist — each one must map to at least one test."

### F3: success side effects not tested in extracted component
**What was caught:** NewBookDefaultsSection save mutation tested toast but not dirty-state reset or query invalidation — both present in the original LibrarySettingsSection tests.
**Why I missed it:** When moving tests to the new component file, wrote fresh tests covering the essentials but didn't port all success lifecycle tests from the original suite. The original had dedicated tests for dirty-state reset and query invalidation that were removed from LibrarySettingsSection.test.tsx.
**Prompt fix:** Add to `/implement` step 4 general rules: "When extracting a component into a new file and migrating its tests, verify the new test file covers the full mutation lifecycle (success + error + state reset + cache invalidation) — not just the subset re-written from scratch."
