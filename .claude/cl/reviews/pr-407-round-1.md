---
skill: respond-to-pr-review
issue: 407
pr: 417
round: 1
date: 2026-03-17
fixed_findings: [F2]
---

### F2: Missing refreshSuggestions() test for snoozed diversity rows
**What was caught:** AC5 lacked a direct `refreshSuggestions()` test proving snoozed diversity rows resurface correctly through `resurfaceSnoozedRows()` → `getStrengthForReason('diversity')`.
**Why I missed it:** The existing snooze tests covered `author` and `narrator` reasons, and I assumed the `getStrengthForReason` unit coverage via `generateCandidates()` was sufficient. I didn't think about the resurfacing path as a separate integration boundary that needs per-reason coverage.
**Prompt fix:** Add to `/plan` test enumeration step: "When adding a new enum variant that flows through an existing polymorphic path (switch/map), enumerate test cases for every existing path that dispatches on that enum — not just the new code path. Check existing tests for the same dispatch point and ensure the new variant has parity."
