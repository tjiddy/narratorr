---
skill: respond-to-pr-review
issue: 212
pr: 213
round: 1
date: 2026-03-30
fixed_findings: [F1, F2, F3, F4, F5]
---

### F1: Missing inline Scan Library action
**What was caught:** The slimmed Library section removed the Scan Library navigation entirely instead of relocating it inline next to the path label.
**Why I missed it:** During extraction, I focused on removing naming UI and the standalone link but didn't add the replacement inline action. The AC said "Browse + Scan Library inline" but I only implemented Browse.
**Prompt fix:** Add to `/implement` step 4a: "For AC items that say 'reduced to X + Y + Z', create a checklist of each element and verify each is present in the final component — removal of old UI is necessary but not sufficient."

### F2: Dirty-state guard removed from useEffect
**What was caught:** The `!isDirty` guard was dropped when simplifying the form, allowing settings refetch to clobber unsaved path edits.
**Why I missed it:** When simplifying from full library form to path-only form, I rewrote the useEffect without preserving the existing guard condition.
**Prompt fix:** Add to `/implement` step 4b: "When extracting code from a component, diff each useEffect and mutation hook against the original — conditions like `!isDirty` guards are the most fragile parts and the most common extraction regression."

### F3: Save-failure test incomplete
**What was caught:** Error test only checked toast, not that the form stays dirty and the save button remains visible for retry.
**Why I missed it:** Wrote the test for the notification but not the recovery flow. The testing standard says "test the full mutation lifecycle" but I only tested the error notification part.
**Prompt fix:** Add to testing.md error-path guidance: "For mutation error tests, always assert both: (1) error notification shown AND (2) form/UI is in a recoverable state (dirty values preserved, submit button still visible)."

### F4: renderFilename separator tests missing
**What was caught:** Separator normalization tested only through renderTemplate, not renderFilename.
**Why I missed it:** Since both share resolveTokens internally, I assumed renderTemplate coverage was sufficient. But each public API needs its own edge case tests.
**Prompt fix:** Add to `/implement` step 4a: "When a shared internal helper changes behavior for multiple public functions, add direct tests for each public function — shared implementation doesn't guarantee shared test coverage."

### F5: File format validation untested
**What was caught:** Only folder format validation was tested; file format validation branch had no coverage.
**Why I missed it:** Wrote one validation test and assumed the parallel branch was covered. The component has two separate validators.
**Prompt fix:** Add to `/implement` step 4a: "When a component has N parallel validation branches (e.g., folder format + file format), test each branch independently."
