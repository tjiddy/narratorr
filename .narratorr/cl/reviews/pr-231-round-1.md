---
skill: respond-to-pr-review
issue: 231
pr: 236
round: 1
date: 2026-03-30
fixed_findings: [F1]
---

### F1: Missing trackTotal single-file and partName multi-file test assertions
**What was caught:** The test suite proved single-file omission for trackNumber and partName, and multi-file inclusion for trackNumber and trackTotal, but had no assertions that would fail if trackTotal leaked through for single-file books or if partName were dropped for multi-file books.
**Why I missed it:** During test writing, I focused on the primary token (trackNumber) and the Plex preset integration tests, which happened to cover some tokens indirectly. I didn't systematically enumerate all 3 tokens × 2 branches = 6 coverage cells and verify each had an independent assertion.
**Prompt fix:** Add to `/plan` step 5 test stub generation: "When a single conditional gates N fields, generate one stub per field per branch (N × 2 stubs minimum). Each stub's template must reference only the token under test — shared templates that exercise multiple tokens simultaneously don't prove individual token behavior."
