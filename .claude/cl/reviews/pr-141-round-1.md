---
skill: respond-to-pr-review
issue: 141
pr: 144
round: 1
date: 2026-03-26
fixed_findings: [F1, F2, F3]
---

### F1: empty-result state machine doesn't leave scanning step
**What was caught:** Setting `emptyResult=true` without `setStep('review')` left `step === 'scanning'`, so the scanning spinner rendered alongside the "All caught up" panel.
**Why I missed it:** The implementation focused on the new variable (`emptyResult`) and wrote assertions only for what should appear, not for what should disappear. State machine early-return paths require checking every UI guard that depends on the old state value.
**Prompt fix:** Add to `/implement` testing standards: "When adding a new early-return path in a state machine handler (setting a flag and returning), check each rendering condition in the page that guards on the old state — and write a negative assertion that the old UI no longer renders."

### F2: edit callback change not covered by page-level test
**What was caught:** The `onEdit` callback was changed alongside `onToggle` to use `rowIndexMap`, but only `onToggle` had a direct page-level test proving correct index resolution.
**Why I missed it:** The plan only called out a single "toggle with hidden duplicate" test. When two symmetrical callbacks are changed in the same diff, both need tests. The plan stub was written at the intent level ("prove rowIndexMap works") rather than at the callback level ("one test per changed callback").
**Prompt fix:** Add to `/plan` test stub generation: "When a refactor touches N symmetrical callbacks (e.g., onToggle and onEdit both using the same lookup), generate one test stub per callback — not one test for the group."

### F3: tooltip precedence interaction not covered
**What was caught:** The BulkButton title ternary had `disabledReason` first, so Convert showed the ffmpeg tooltip even when another job was running. AC5 tests only covered buttons without a `disabledReason`.
**Why I missed it:** The AC5 tests were written for the two simplest cases (Rename/Retag with no disabledReason). The intersection with AC6 (Convert which has a permanent disabledReason) was not tested. Interaction coverage between two ACs that affect the same component was missing.
**Prompt fix:** Add to `/plan`: "When two ACs both affect the same UI element (e.g., AC5 busy-tooltip and AC6 ffmpeg-tooltip both set the Convert button's title), add a test for their intersection: what does the element show when both conditions are active simultaneously?"
