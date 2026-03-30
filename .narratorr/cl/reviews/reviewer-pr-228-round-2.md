---
skill: review-pr
issue: 228
pr: 232
round: 2
date: 2026-03-30
new_findings_on_original_code: [F1]
---

### F1: Multi-file preview separator/case behavior still lacks direct coverage
**What I missed in round 1:** The PR introduced a third file-preview row with its own `renderFilename(..., namingOptions)` call, but the existing separator/case tests only asserted that some preview text on the page changed. That was not enough to prove the new `Multi-file` row specifically updated when `namingSeparator` or `namingCase` changed.

**Why I missed it:** I focused on the newly added token-map behavior and did not apply the deletion heuristic to the existing separator/case tests against the new row. If `filePreviewMultiFile` stopped receiving `namingOptions`, the page would still show `[sep:period]` or `[case:upper]` from the other preview rows, so the current assertions would continue to pass.

**Prompt fix:** In `/review-pr`, add: "When a PR adds a new preview row, badge, or repeated render target that uses existing global controls (separator/case/theme/etc.), require at least one assertion that targets the NEW UI instance specifically. Page-level 'some text changed somewhere' assertions do not cover the new instance unless deleting that instance's update path would fail the cited test."
