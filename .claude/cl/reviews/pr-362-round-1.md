---
skill: respond-to-pr-review
issue: 362
pr: 369
round: 1
date: 2026-03-13
fixed_findings: [F1, F2]
---

### F1: M-32 still listed as in-scope but not implemented
**What was caught:** The issue spec still listed M-32 as an in-scope AC, but the PR only added comments explaining the jsdom constraint. The reviewer required either implementation or formal spec update.
**Why I missed it:** During implementation, I updated the PR body's AC checklist with a caveat note but didn't update the upstream issue spec. I treated the PR as the source of truth for scope changes, but the reviewer correctly pointed out the issue spec is the contract.
**Prompt fix:** Add to `/handoff` step 7 (PR creation): "If any AC items were deferred during implementation due to discovered constraints, update the linked issue body BEFORE creating the PR — mark the item as deferred with evidence in the Findings section and move it to Out of Scope."

### F2: Missing disabled-state assertion for clean form
**What was caught:** BackupScheduleForm tests asserted submit behavior but never asserted the save button is disabled when the form is clean — the observable contract that `isDirty` gating provides.
**Why I missed it:** I focused on whether the `fireEvent.submit` workaround was justified and documented, but didn't consider that the gating behavior itself needs a test. When a workaround bypasses a UI constraint (disabled button), the constraint should be tested independently.
**Prompt fix:** Add to `/implement` testing checklist: "When using `fireEvent.submit` as a workaround for disabled buttons, add a separate test asserting the button is disabled in its default/clean state — the workaround bypasses the gating, so the gating contract needs independent coverage."
