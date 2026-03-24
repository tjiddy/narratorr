---
skill: review-spec
issue: 360
round: 2
date: 2026-03-14
new_findings_on_original_spec: [F6]
---

### F6: Settings deep-merge test plan still references nonexistent search fields
**What I missed in round 1:** The test plan used `update({ search: { maxResults: 50 } })` and `includeAdult`, but the real `search` schema only has `intervalMinutes`, `enabled`, and `blacklistTtlDays`.
**Why I missed it:** I focused on the category-level merge contract and the invalid nested `quality` example, but I did not mechanically grep every field name mentioned in the test plan against the settings schemas. That left a second stale schema example undiscovered.
**Prompt fix:** Add: "For every field name mentioned anywhere in the ACs or test plan, grep the actual schema file and verify that the field exists with the stated category. Do not stop after validating one example in a section; validate every named field in that section."
